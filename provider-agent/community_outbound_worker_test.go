package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type communityBackendSelectionStub struct{ runtimeID string }

func (backend *communityBackendSelectionStub) CommunityRuntimeID() string { return backend.runtimeID }
func (backend *communityBackendSelectionStub) CommunityCatalog() providerModelCatalog {
	return providerModelCatalog{}
}
func (backend *communityBackendSelectionStub) Execute(context.Context, runtimeExecuteRequest) (runtimeExecuteResult, error) {
	return runtimeExecuteResult{}, nil
}
func (backend *communityBackendSelectionStub) ExecuteStream(context.Context, runtimeExecuteRequest, func(runtimeExecuteChunk) error) (runtimeExecutionSummary, error) {
	return runtimeExecutionSummary{}, nil
}

func TestCommunityOutboundBackendSelectionIsExactAndFailsClosed(t *testing.T) {
	ollama := &communityBackendSelectionStub{runtimeID: "ollama"}
	pair := &communityBackendSelectionStub{runtimeID: "nvidia-pair"}
	selected, err := communityBackendForRuntime("ollama", pair, ollama)
	if err != nil || selected != ollama {
		t.Fatalf("exact runtime backend was not selected: selected=%T err=%v", selected, err)
	}
	if _, err := communityBackendForRuntime("vllm", ollama, pair); err == nil {
		t.Fatal("unknown runtime silently selected a backend")
	}
	if _, err := communityBackendForRuntime("ollama", ollama, &communityBackendSelectionStub{runtimeID: "ollama"}); err == nil {
		t.Fatal("ambiguous runtime backend registration was accepted")
	}
}

func signedCommunityOutboundClaim(t *testing.T, now time.Time) (communityOutboundClaim, ed25519.PublicKey) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	spki, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		t.Fatal(err)
	}
	keyDigest := sha256.Sum256(spki)
	keyID := "ed25519:" + base64.RawURLEncoding.EncodeToString(keyDigest[:])
	body := []byte(`{"model":"qwen2.5:0.5b","messages":[{"role":"user","content":"hello"}]}`)
	bodyDigest := sha256.Sum256(body)
	payload := communityInferencePayload{
		Kind: "inference_request", ProtocolVersion: communityInferenceProtocol,
		CanonicalizationVersion: relayCanonicalization, RequestID: "request-one", AttemptID: "attempt-one",
		RouteID: "route-one", ProviderID: "provider-one", Model: "qwen/qwen2.5-0.5b-instruct",
		UpstreamModel: "qwen2.5:0.5b", Protocol: "openai", Operation: "chat_completions",
		Path: "/v1/chat/completions", Stream: false,
		RequestDigest: communityRequestDigest("openai", "chat_completions", "/v1/chat/completions", body),
		BodyDigest:    hex.EncodeToString(bodyDigest[:]), BodyBytes: uint64(len(body)),
		Nonce:     base64.RawURLEncoding.EncodeToString(make([]byte, 32)),
		IssuedAt:  now.Format("2006-01-02T15:04:05.000Z"),
		ExpiresAt: now.Add(30 * time.Second).Format("2006-01-02T15:04:05.000Z"),
	}
	envelope := signedCommunityInferenceRequest{
		EnvelopeVersion: communityInferenceEnvelope, Kind: "inference_request", Payload: payload,
		Signature: communityInferenceSignature{Algorithm: relaySignatureAlgorithm, KeyID: keyID},
	}
	canonical, err := canonicalJSON(unsignedCommunityInferenceMap(envelope), 64*1024)
	if err != nil {
		t.Fatal(err)
	}
	envelope.Signature.Value = base64.RawURLEncoding.EncodeToString(ed25519.Sign(
		privateKey, append(append([]byte{}, communityInferenceSigningDomain...), canonical...),
	))
	return communityOutboundClaim{
		JobID: "01991abc-1234-7123-8123-0123456789ab", LeaseID: "01991abc-1234-7123-8123-0123456789ac",
		LeaseExpiresAt: now.Add(20 * time.Second).Format("2006-01-02T15:04:05.000Z"),
		Wire:           communityInferenceWireRequest{Envelope: envelope, Body: base64.RawURLEncoding.EncodeToString(body)},
	}, publicKey
}

func communityOutboundVerificationWorker(t *testing.T, claim communityOutboundClaim, key ed25519.PublicKey) *communityOutboundWorker {
	t.Helper()
	keyID := claim.Wire.Envelope.Signature.KeyID
	enrollment := newMemoryCloudEnrollmentStore()
	enrollment.current = &cloudEnrollmentView{ProviderID: "provider-one"}
	return &communityOutboundWorker{
		enrollment: enrollment,
		catalog: providerModelCatalog{SchemaVersion: providerModelCatalogSchemaVersion, Models: []providerModelCatalogEntry{{
			CanonicalModelID: "hf:qwen/qwen2.5-0.5b-instruct", OllamaModel: "qwen2.5:0.5b",
		}}},
		trusted: trustedProviderDemandKeys{keyID: key},
	}
}

func TestCommunityOutboundVerificationBindsSignatureBodyProviderAndCatalogModel(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Millisecond)
	claim, publicKey := signedCommunityOutboundClaim(t, now)
	worker := communityOutboundVerificationWorker(t, claim, publicKey)
	body, modelID, err := worker.verify(claim, now)
	if err != nil || modelID != "hf:qwen/qwen2.5-0.5b-instruct" || !strings.Contains(string(body), `"messages"`) {
		t.Fatalf("valid signed claim was rejected: model=%q body=%q err=%v", modelID, body, err)
	}

	tests := map[string]func(*communityOutboundClaim){
		"body digest": func(value *communityOutboundClaim) {
			value.Wire.Body = base64.RawURLEncoding.EncodeToString([]byte(`{"model":"other"}`))
		},
		"provider": func(value *communityOutboundClaim) { value.Wire.Envelope.Payload.ProviderID = "provider-two" },
		"model":    func(value *communityOutboundClaim) { value.Wire.Envelope.Payload.UpstreamModel = "other:latest" },
		"signature": func(value *communityOutboundClaim) {
			value.Wire.Envelope.Signature.Value = base64.RawURLEncoding.EncodeToString(make([]byte, 64))
		},
		"expired": func(value *communityOutboundClaim) {
			value.Wire.Envelope.Payload.ExpiresAt = now.Format("2006-01-02T15:04:05.000Z")
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			copy := claim
			mutate(&copy)
			if _, _, err := worker.verify(copy, now); err == nil {
				t.Fatal("mutated community inference claim was accepted")
			}
		})
	}
}

func TestCommunityOutboundReplayFencePersistsBeforeDispatch(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Millisecond)
	path := filepath.Join(t.TempDir(), "state", "replay.json")
	store, err := openCommunityOutboundReplayStore(path)
	if err != nil {
		t.Fatal(err)
	}
	first, err := store.begin("attempt-one", strings.Repeat("a", 64), now.Add(time.Hour), now)
	if err != nil || !first {
		t.Fatalf("first dispatch was not durably fenced: first=%t err=%v", first, err)
	}
	reopened, err := openCommunityOutboundReplayStore(path)
	if err != nil {
		t.Fatal(err)
	}
	first, err = reopened.begin("attempt-one", strings.Repeat("a", 64), now.Add(time.Hour), now)
	if err != nil || first {
		t.Fatalf("replayed dispatch was not rejected after restart: first=%t err=%v", first, err)
	}
	if _, err := reopened.begin("attempt-one", strings.Repeat("b", 64), now.Add(time.Hour), now); err == nil {
		t.Fatal("replayed attempt with another digest was accepted")
	}
	raw, err := json.Marshal(reopened.entries)
	if err != nil || len(raw) == 0 {
		t.Fatal("replay evidence was not retained")
	}
}

func TestCommunityOutboundSessionReplacementFailsClosed(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Millisecond)
	store := &communityOutboundSessionStore{}
	session := &communityOutboundSession{
		Token:     base64.RawURLEncoding.EncodeToString(make([]byte, 32)),
		ExpiresAt: now.Add(time.Minute).Format("2006-01-02T15:04:05.000Z"), PollAfterMS: 250,
	}
	if err := store.replace(session, now); err != nil || store.snapshot(now) == nil {
		t.Fatalf("valid relay session was rejected: %v", err)
	}
	invalid := *session
	invalid.Token = "invalid"
	if err := store.replace(&invalid, now); err == nil {
		t.Fatal("invalid relay session was accepted")
	}
	if store.snapshot(now.Add(2*time.Minute)) != nil {
		t.Fatal("expired relay session remained usable")
	}
}

func TestCommunityOutboundStatusContainsOnlyBoundedOperationalCounters(t *testing.T) {
	stats := newCommunityOutboundWorkerStats()
	stats.update(func(status *communityOutboundWorkerStatus) {
		status.Claims = 2
		status.Executions = 1
		status.RenewFailures = 3
		status.Cancellations = 1
		status.StreamFailures = 1
		status.CompletionFailures = 1
		status.LastClaimedAt = "2035-01-01T00:00:00.000Z"
		status.LastErrorCategory = "renew_failed"
	})
	worker := &communityOutboundWorker{stats: stats}
	status := worker.status()
	if status.SchemaVersion != "community-outbound-worker-status-v1" || status.Claims != 2 ||
		status.Executions != 1 || status.RenewFailures != 3 || status.LastErrorCategory != "renew_failed" {
		t.Fatalf("unexpected community outbound status: %#v", status)
	}
	encoded, err := json.Marshal(status)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"prompt", "output", "authorization", "token", "body"} {
		if strings.Contains(strings.ToLower(string(encoded)), forbidden) {
			t.Fatalf("community outbound status contains forbidden field %q: %s", forbidden, encoded)
		}
	}
}

func TestCommunityOutboundStatusRouteRequiresLocalControlAuthentication(t *testing.T) {
	const token = "community-outbound-local-control-token-with-at-least-32-characters"
	worker := &communityOutboundWorker{stats: newCommunityOutboundWorkerStats()}
	handler := providerHandlerWithModelLifecycle(nil, nil, nil, nil, nil, nil, nil, nil, hostCapability{}, nil,
		worker, &http.Client{}, token)
	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/v1/community-outbound/status", nil))
	if unauthorized.Code != http.StatusNotFound {
		t.Fatalf("unauthenticated status was exposed: %d", unauthorized.Code)
	}
	authorized := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/v1/community-outbound/status", nil)
	request.Header.Set("authorization", "Bearer "+token)
	handler.ServeHTTP(authorized, request)
	if authorized.Code != http.StatusOK || !strings.Contains(authorized.Body.String(), "community-outbound-worker-status-v1") {
		t.Fatalf("unexpected authenticated status: %d %s", authorized.Code, authorized.Body.String())
	}
}
