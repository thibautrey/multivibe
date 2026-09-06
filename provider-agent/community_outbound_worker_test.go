package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

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
