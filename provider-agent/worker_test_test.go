package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func verifyWorkerTestSession(t *testing.T, envelope signedWorkerTestSession, publicKey ed25519.PublicKey) {
	t.Helper()
	if envelope.Kind != "worker_test_session" || !envelope.Payload.TestOnly ||
		envelope.Payload.RoutingEligible || envelope.Payload.CompensationEligible {
		t.Fatalf("worker session crossed its test-only boundary: %#v", envelope)
	}
	canonical, err := canonicalJSON(map[string]any{
		"envelopeVersion": providerControlEnvelope,
		"kind":            "worker_test_session",
		"payload":         workerTestPayloadMap(envelope.Payload),
		"signature": map[string]any{
			"algorithm": relaySignatureAlgorithm,
			"keyId":     envelope.Signature.KeyID,
		},
	}, maxRelayEnvelopeBytes)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := base64.RawURLEncoding.DecodeString(envelope.Signature.Value)
	if err != nil || !ed25519.Verify(publicKey, append(append([]byte{}, providerControlSigningDomain...), canonical...), signature) {
		t.Fatal("worker test session signature is invalid")
	}
}

func TestWorkerTestUsesCloudManagedModelFromLoopbackRuntime(t *testing.T) {
	identity, err := newMemoryDeviceIdentity()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC)
	model := "Qwen3.8-27B-4bit"
	runtimeCalled := false
	runtimeServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodGet && request.URL.Path == "/v1/models" {
			response.Header().Set("content-type", "application/json")
			_, _ = response.Write([]byte(`{"data":[{"id":"Qwen3.8-27B-4bit"}]}`))
			return
		}
		if request.Method != http.MethodPost || request.URL.Path != "/v1/chat/completions" {
			t.Fatalf("unexpected runtime request: %s %s", request.Method, request.URL.Path)
		}
		var payload struct {
			Model    string `json:"model"`
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		if json.NewDecoder(request.Body).Decode(&payload) != nil || payload.Model != model || len(payload.Messages) != 1 ||
			payload.Messages[0].Role != "user" || payload.Messages[0].Content != "Reply with exactly MULTIVIBE_WORKER_OK." {
			t.Fatalf("runtime received an unexpected request")
		}
		runtimeCalled = true
		response.Header().Set("content-type", "application/json")
		_, _ = response.Write([]byte(`{"choices":[{"message":{"content":"MULTIVIBE_WORKER_OK"}}],"usage":{"prompt_tokens":9,"completion_tokens":6}}`))
	}))
	defer runtimeServer.Close()

	completed := false
	cloudServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("content-type", "application/json")
		switch request.URL.Path {
		case "/provider/v1/worker-test-sessions":
			var envelope signedWorkerTestSession
			if request.Method != http.MethodPost || json.NewDecoder(request.Body).Decode(&envelope) != nil {
				t.Fatal("worker session request is invalid")
			}
			verifyWorkerTestSession(t, envelope, identity.privateKey.Public().(ed25519.PublicKey))
			_ = json.NewEncoder(response).Encode(workerTestSessionView{
				SessionToken: "mwt_" + strings.Repeat("a", 43), ExpiresAt: now.Add(10 * time.Minute).Format("2006-01-02T15:04:05.000Z"),
				NodeID: testNodeID, TestOnly: true, RoutingEffectsApplied: false, MonetaryEffectsApplied: false,
			})
		case "/provider/v1/worker-test-poll":
			if request.Header.Get("authorization") != "Bearer mwt_"+strings.Repeat("a", 43) {
				t.Fatal("worker session bearer is missing")
			}
			_ = json.NewEncoder(response).Encode(workerTestPollResponse{Job: &workerTestClaim{
				JobID: testEnrollmentID, NodeID: testNodeID, Model: providerCloudAssignedModel,
				Prompt: "Reply with exactly MULTIVIBE_WORKER_OK.", ExpiresAt: now.Add(5 * time.Minute).Format("2006-01-02T15:04:05.000Z"), TestOnly: true,
			}})
		case "/provider/v1/worker-test-jobs/" + testEnrollmentID + "/complete":
			var payload struct {
				Outcome      string `json:"outcome"`
				OutputText   string `json:"output_text"`
				InputTokens  uint64 `json:"input_tokens"`
				OutputTokens uint64 `json:"output_tokens"`
			}
			if json.NewDecoder(request.Body).Decode(&payload) != nil || payload.Outcome != "completed" ||
				payload.OutputText != "MULTIVIBE_WORKER_OK" || payload.InputTokens != 9 || payload.OutputTokens != 6 {
				t.Fatal("worker completion is invalid")
			}
			completed = true
			_, _ = response.Write([]byte(`{}`))
		default:
			http.NotFound(response, request)
		}
	}))
	defer cloudServer.Close()
	cloudURL, err := cloudAPIURL(cloudServer.URL)
	if err != nil {
		t.Fatal(err)
	}
	store := newMemoryCloudEnrollmentStore()
	keyID, _ := identity.publicIdentity()
	if err := store.record(cloudEnrollmentView{
		SchemaVersion: providerEnrollmentStateV1, Revision: 1, State: "submitted",
		ProviderID: testProviderID, NodeID: testNodeID, DeviceKeyID: keyID, CredentialEpoch: 1,
		ManifestDigest: strings.Repeat("8", 64), RuntimeFamily: providerCloudManagedRuntime, DeclaredMaxConcurrency: 1,
		CloudAPIOrigin: cloudServer.URL, SubmittedAt: now.Format("2006-01-02T15:04:05.000Z"),
		RoutingEligible: false, CompensationEligible: false, SafetyProfile: "shadow_only_no_routing_no_compensation",
	}); err != nil {
		t.Fatal(err)
	}
	runtimes := newMemoryRuntimeEndpointStore()
	if _, conflict, err := runtimes.replace(1, []runtimeEndpoint{{AdapterID: "manual-openai-compatible", Endpoint: runtimeServer.URL}}, runtimeAdapterRegistry()); err != nil || conflict {
		t.Fatalf("runtime setup failed: conflict=%v err=%v", conflict, err)
	}
	service := newWorkerTestService(cloudURL, http.DefaultClient, identity, store, runtimes)
	service.now = func() time.Time { return now }
	session, err := service.openSession(context.Background(), *store.snapshot())
	if err != nil {
		t.Fatal(err)
	}
	claim, err := service.poll(context.Background(), session.SessionToken)
	if err != nil || claim == nil {
		t.Fatalf("worker test claim failed: %#v %v", claim, err)
	}
	if claim.Model != model {
		t.Fatalf("Cloud-managed claim was not resolved to the live runtime model: %q", claim.Model)
	}
	output, inputTokens, outputTokens, inferenceErr := service.infer(context.Background(), *store.snapshot(), *claim)
	if inferenceErr != nil {
		t.Fatal(inferenceErr)
	}
	if err := service.complete(context.Background(), session.SessionToken, *claim, output, inputTokens, outputTokens, nil); err != nil {
		t.Fatal(err)
	}
	if !runtimeCalled || !completed {
		t.Fatal("Cloud to local runtime corridor did not complete")
	}
}

func TestWorkerTestRequiresTheExactSyntheticResponse(t *testing.T) {
	for _, output := range []string{"", " MULTIVIBE_WORKER_OK", "MULTIVIBE_WORKER_OK\n", "anything else"} {
		t.Run(output, func(t *testing.T) {
			runtimeServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				response.Header().Set("content-type", "application/json")
				if request.Method == http.MethodGet && request.URL.Path == "/v1/models" {
					_, _ = response.Write([]byte(`{"data":[{"id":"registered/model"}]}`))
					return
				}
				_ = json.NewEncoder(response).Encode(map[string]any{
					"choices": []any{map[string]any{"message": map[string]any{"content": output}}},
					"usage":   map[string]any{"prompt_tokens": 9, "completion_tokens": 6},
				})
			}))
			defer runtimeServer.Close()
			runtimes := newMemoryRuntimeEndpointStore()
			if _, conflict, err := runtimes.replace(1, []runtimeEndpoint{{AdapterID: "manual-openai-compatible", Endpoint: runtimeServer.URL}}, runtimeAdapterRegistry()); err != nil || conflict {
				t.Fatalf("runtime setup failed: conflict=%v err=%v", conflict, err)
			}
			service := newWorkerTestService(nil, http.DefaultClient, nil, nil, runtimes)
			claim := workerTestClaim{Model: "registered/model", Prompt: "Reply with exactly MULTIVIBE_WORKER_OK.", TestOnly: true, ExpiresAt: time.Now().UTC().Add(time.Minute).Format("2006-01-02T15:04:05.000Z")}
			enrollment := cloudEnrollmentView{RuntimeFamily: "manual-openai-compatible"}
			if _, _, _, err := service.infer(context.Background(), enrollment, claim); err == nil {
				t.Fatal("non-exact synthetic response was accepted")
			}
		})
	}
}

func TestWorkerTestRejectsUnregisteredModelBeforeRuntimeCall(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Millisecond)
	store := newMemoryCloudEnrollmentStore()
	if err := store.record(cloudEnrollmentView{
		SchemaVersion: providerEnrollmentStateV1, Revision: 1, State: "submitted",
		ProviderID: testProviderID, NodeID: testNodeID, DeviceKeyID: "ed25519:" + strings.Repeat("a", 43), CredentialEpoch: 1,
		ManifestDigest: strings.Repeat("b", 64), RuntimeFamily: "manual-openai-compatible", DeclaredMaxConcurrency: 1,
		CloudAPIOrigin: "http://127.0.0.1:65534", SubmittedAt: now.Format("2006-01-02T15:04:05.000Z"),
		RoutingEligible: false, CompensationEligible: false, SafetyProfile: "shadow_only_no_routing_no_compensation",
	}); err != nil {
		t.Fatal(err)
	}
	claim := &workerTestClaim{
		JobID: testEnrollmentID, NodeID: testNodeID, Model: "other/model",
		Prompt: "Reply with exactly MULTIVIBE_WORKER_OK.", ExpiresAt: now.Add(time.Minute).Format("2006-01-02T15:04:05.000Z"), TestOnly: true,
	}
	encoded, _ := json.Marshal(workerTestPollResponse{Job: claim})
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) { _, _ = response.Write(encoded) }))
	defer server.Close()
	runtimeCalled := false
	runtimeServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/v1/models" {
			runtimeCalled = true
		}
		response.Header().Set("content-type", "application/json")
		_, _ = response.Write([]byte(`{"data":[{"id":"registered/model"}]}`))
	}))
	defer runtimeServer.Close()
	runtimes := newMemoryRuntimeEndpointStore()
	if _, conflict, err := runtimes.replace(1, []runtimeEndpoint{{AdapterID: "manual-openai-compatible", Endpoint: runtimeServer.URL}}, runtimeAdapterRegistry()); err != nil || conflict {
		t.Fatalf("runtime setup failed: conflict=%v err=%v", conflict, err)
	}
	cloudURL, _ := cloudAPIURL(server.URL)
	service := newWorkerTestService(cloudURL, http.DefaultClient, nil, store, runtimes)
	service.now = func() time.Time { return now }
	if _, err := service.poll(context.Background(), "mwt_"+strings.Repeat("a", 43)); err == nil {
		t.Fatal("an unregistered model must be rejected")
	}
	if runtimeCalled {
		t.Fatal("an unregistered model reached the local inference endpoint")
	}
}
