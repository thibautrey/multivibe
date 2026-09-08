package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// Exercise real enrollment, persistence, discovery and the worker run loop over
// HTTP. Cloud and the model engine are deterministic peers; no live credentials,
// downloaded weights or commercial routing eligibility are required.
func TestWorkerCloudIntegrationEnrollmentDiscoveryAndInference(t *testing.T) {
	for _, scenario := range []struct {
		name            string
		runtimeStatus   int
		output, outcome string
	}{
		{"success", 200, "MULTIVIBE_WORKER_OK", "completed"},
		{"runtime_unavailable", 503, "", "failed"},
		{"invalid_output", 200, "unexpected", "failed"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			now := time.Now().UTC().Truncate(time.Millisecond)
			stamp := func(d time.Duration) string { return now.Add(d).Format("2006-01-02T15:04:05.000Z") }
			identity, err := newMemoryDeviceIdentity()
			if err != nil {
				t.Fatal(err)
			}
			keyID, _ := identity.publicIdentity()
			const model = "qwen2.5:0.5b"
			grant := "mve_" + strings.Repeat("a", 43)
			sessionToken := "mwt_" + strings.Repeat("b", 43)
			var mu sync.Mutex
			var events []string
			record := func(event string) { mu.Lock(); defer mu.Unlock(); events = append(events, event) }
			completion := make(chan map[string]any, 1)
			signedSessions := make(chan signedWorkerTestSession, 1)
			runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("content-type", "application/json")
				if r.Header.Get("authorization") != "" {
					t.Error("Cloud credential leaked to runtime")
				}
				if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" {
					t.Errorf("unexpected runtime route: %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
					return
				}
				record("infer")
				var input struct {
					Model    string              `json:"model"`
					Messages []map[string]string `json:"messages"`
					Stream   bool                `json:"stream"`
				}
				if json.NewDecoder(r.Body).Decode(&input) != nil || input.Model != model || input.Stream || !reflect.DeepEqual(input.Messages, []map[string]string{{"role": "user", "content": workerTestPrompt}}) {
					t.Error("runtime inference payload did not preserve the Cloud job")
				}
				w.WriteHeader(scenario.runtimeStatus)
				_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": scenario.output}}}, "usage": map[string]int{"prompt_tokens": 9, "completion_tokens": 6}})
			}))
			defer runtime.Close()
			cloud := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("content-type", "application/json")
				if r.Method != http.MethodPost {
					t.Errorf("unexpected Cloud method: %s", r.Method)
					w.WriteHeader(405)
					return
				}
				switch r.URL.Path {
				case "/provider/v1/enrollment-challenges":
					record("enroll")
					var begin cloudEnrollmentChallengeRequest
					if json.NewDecoder(r.Body).Decode(&begin) != nil || begin.Manifest.RuntimeFamily != providerCloudManagedRuntime || len(begin.Manifest.SelectedModels) != 0 {
						t.Error("enrollment manifest was not Cloud-managed and model-agnostic")
					}
					if r.Header.Get("authorization") != "Bearer "+grant {
						t.Error("missing enrollment grant")
					}
					no := false
					w.WriteHeader(201)
					_ = json.NewEncoder(w).Encode(cloudEnrollmentChallenge{EnrollmentID: testEnrollmentID, ChallengeID: testChallengeID, ProviderID: testProviderID, NodeID: testNodeID, DeviceKeyID: keyID, Nonce: base64.RawURLEncoding.EncodeToString(make([]byte, 32)), ManifestDigest: strings.Repeat("c", 64), DisclosureVersion: "shadow-disclosure-v1", IssuedAt: stamp(0), ExpiresAt: stamp(5 * time.Minute), State: "challenge_issued", RoutingEligible: &no, CompensationEligible: &no})
				case "/provider/v1/enrollments/" + testEnrollmentID + "/proofs":
					record("proof")
					var proof signedEnrollmentProof
					if json.NewDecoder(r.Body).Decode(&proof) != nil {
						t.Error("invalid proof JSON")
						w.WriteHeader(400)
						return
					}
					// Verify without calling Fatal from the HTTP handler goroutine.
					canonical, e := canonicalJSON(map[string]any{"envelopeVersion": providerControlEnvelope, "kind": "enrollment_proof", "payload": enrollmentPayloadMap(proof.Payload), "signature": map[string]any{"algorithm": relaySignatureAlgorithm, "keyId": keyID}}, maxRelayEnvelopeBytes)
					signature, se := base64.RawURLEncoding.DecodeString(proof.Signature.Value)
					if e != nil || se != nil || !ed25519.Verify(identity.privateKey.Public().(ed25519.PublicKey), append([]byte(providerControlSigningDomain), canonical...), signature) {
						t.Error("invalid enrollment signature")
					}
					if r.Header.Get("authorization") != "" {
						t.Error("grant forwarded to proof endpoint")
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"providerId": testProviderID, "nodeId": testNodeID, "deviceKeyId": keyID, "state": "submitted", "credentialEpoch": 1, "manifestDigest": strings.Repeat("c", 64), "routingEligible": false, "compensationEligible": false})
				case "/provider/v1/worker-test-sessions":
					record("session")
					var envelope signedWorkerTestSession
					if json.NewDecoder(r.Body).Decode(&envelope) != nil || envelope.Payload.NodeID != testNodeID || envelope.Payload.DeviceKeyID != keyID || envelope.Payload.CredentialEpoch != 1 {
						t.Error("session did not use persisted enrollment identity")
					}
					signedSessions <- envelope
					_ = json.NewEncoder(w).Encode(workerTestSessionView{SessionToken: sessionToken, ExpiresAt: stamp(10 * time.Minute), NodeID: testNodeID, TestOnly: true})
				case "/provider/v1/worker-test-poll":
					record("poll")
					if r.Header.Get("authorization") != "Bearer "+sessionToken {
						t.Error("missing session bearer")
					}
					_ = json.NewEncoder(w).Encode(workerTestPollResponse{Job: &workerTestClaim{JobID: testEnrollmentID, NodeID: testNodeID, Model: workerTestCanonicalModel, Prompt: workerTestPrompt, ExpiresAt: stamp(time.Minute), TestOnly: true}})
				case "/provider/v1/worker-test-jobs/" + testEnrollmentID + "/complete":
					record("complete")
					if r.Header.Get("authorization") != "Bearer "+sessionToken {
						t.Error("completion missing session bearer")
					}
					var body map[string]any
					if json.NewDecoder(r.Body).Decode(&body) != nil {
						t.Error("invalid completion")
					}
					select {
					case completion <- body:
					default:
						t.Error("duplicate completion")
					}
					_, _ = w.Write([]byte(`{}`))
				default:
					t.Errorf("unexpected Cloud route: %s", r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer cloud.Close()
			cloudURL, err := cloudAPIURL(cloud.URL)
			if err != nil {
				t.Fatal(err)
			}
			statePath := filepath.Join(t.TempDir(), "enrollment.json")
			store, err := openCloudEnrollmentStore(statePath)
			if err != nil {
				t.Fatal(err)
			}
			enrollment := newCloudEnrollmentService(cloudURL, cloud.Client(), identity, store)
			if _, err := enrollment.enroll(ctx, cloudEnrollmentInput{EnrollmentToken: grant, CoreVersion: "0.2.0", RuntimeFamily: providerCloudManagedRuntime, SelectedModels: []cloudEnrollmentModel{}, DeclaredMaxConcurrency: 1}); err != nil {
				t.Fatal(err)
			}
			// Reopen from disk so the inference phase cannot rely on transient state.
			restored, err := openCloudEnrollmentStore(statePath)
			if err != nil {
				t.Fatal(err)
			}
			managed := &runtimeEndpoint{AdapterID: managedWorkerAdapterID, Endpoint: runtime.URL}
			service := newWorkerTestService(cloudURL, cloud.Client(), identity, restored, managed, &workerTestManagedRuntimeStub{})
			done := make(chan struct{})
			go func() { defer close(done); service.run(ctx) }()
			var result map[string]any
			select {
			case result = <-completion:
			case <-ctx.Done():
				t.Error("worker cycle did not complete before deadline")
			}
			cancel()
			<-done
			select {
			case envelope := <-signedSessions:
				verifyWorkerTestSession(t, envelope, identity.privateKey.Public().(ed25519.PublicKey))
			default:
				t.Error("missing signed worker session")
			}
			expected := map[string]any{"outcome": "failed", "error_code": "local_inference_failed"}
			if scenario.outcome == "completed" {
				expected = map[string]any{"outcome": "completed", "output_text": "MULTIVIBE_WORKER_OK", "input_tokens": float64(9), "output_tokens": float64(6)}
			}
			if !reflect.DeepEqual(result, expected) {
				t.Errorf("completion = %#v; want %#v", result, expected)
			}
			mu.Lock()
			got := append([]string(nil), events...)
			mu.Unlock()
			if !reflect.DeepEqual(got, []string{"enroll", "proof", "session", "poll", "infer", "complete"}) {
				t.Errorf("unexpected cycle: %v", got)
			}
		})
	}
}
