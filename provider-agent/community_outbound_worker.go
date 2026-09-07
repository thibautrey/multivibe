package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	communityInferenceProtocol        = "multivibe-community-inference-v1"
	communityInferenceEnvelope        = "multivibe-community-inference-envelope-v1"
	communityInferenceMaximumBody     = 8 * 1024 * 1024
	communityInferenceMaximumWire     = 12 * 1024 * 1024
	communityInferenceMaximumResponse = 12 * 1024 * 1024
	communityInferenceMaximumChunk    = 1024 * 1024
	// A maximum binary response expands to 16 MiB in base64url form. The JSON
	// completion envelope needs a small, separately bounded allowance.
	communityOutboundMaximumPost  = 17 * 1024 * 1024
	communityOutboundStateVersion = "community-outbound-replay-state-v1"
)

var (
	communityInferenceSigningDomain = []byte("MultiVibe Community Inference\x00multivibe-community-inference-v1\x00signed-request-v1\x00")
	communityInferenceIdentifier    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,191}$`)
	communityInferenceProviderID    = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{1,119}$`)
	communityInferenceDigest        = regexp.MustCompile(`^[a-f0-9]{64}$`)
	communityInferenceUUID          = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
)

type communityInferencePayload struct {
	Kind                    string `json:"kind"`
	ProtocolVersion         string `json:"protocolVersion"`
	CanonicalizationVersion string `json:"canonicalizationVersion"`
	RequestID               string `json:"requestId"`
	AttemptID               string `json:"attemptId"`
	RouteID                 string `json:"routeId"`
	ProviderID              string `json:"providerId"`
	Model                   string `json:"model"`
	UpstreamModel           string `json:"upstreamModel"`
	Protocol                string `json:"protocol"`
	Operation               string `json:"operation"`
	Path                    string `json:"path"`
	Stream                  bool   `json:"stream"`
	RequestDigest           string `json:"requestDigest"`
	BodyDigest              string `json:"bodyDigest"`
	BodyBytes               uint64 `json:"bodyBytes"`
	Nonce                   string `json:"nonce"`
	IssuedAt                string `json:"issuedAt"`
	ExpiresAt               string `json:"expiresAt"`
}

type communityInferenceSignature struct {
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"keyId"`
	Value     string `json:"value"`
}

type signedCommunityInferenceRequest struct {
	EnvelopeVersion string                      `json:"envelopeVersion"`
	Kind            string                      `json:"kind"`
	Payload         communityInferencePayload   `json:"payload"`
	Signature       communityInferenceSignature `json:"signature"`
}

type communityInferenceWireRequest struct {
	Envelope signedCommunityInferenceRequest `json:"envelope"`
	Body     string                          `json:"body"`
}

type communityOutboundClaim struct {
	JobID          string                        `json:"jobId"`
	LeaseID        string                        `json:"leaseId"`
	LeaseExpiresAt string                        `json:"leaseExpiresAt"`
	Wire           communityInferenceWireRequest `json:"wire"`
}

type communityOutboundReplayEntry struct {
	RequestDigest string `json:"request_digest"`
	ExpiresAt     string `json:"expires_at"`
}

type communityOutboundReplayDocument struct {
	SchemaVersion string                                  `json:"schema_version"`
	Entries       map[string]communityOutboundReplayEntry `json:"entries"`
}

type communityOutboundReplayStore struct {
	mu      sync.Mutex
	path    string
	entries map[string]communityOutboundReplayEntry
}

func openCommunityOutboundReplayStore(path string) (*communityOutboundReplayStore, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("community outbound replay state path is invalid")
	}
	store := &communityOutboundReplayStore{path: path, entries: make(map[string]communityOutboundReplayEntry)}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil || !providerPrivateFile(path, info) || info.Size() < 1 || info.Size() > 1024*1024 {
		return nil, errors.New("community outbound replay state is invalid")
	}
	raw, err := os.ReadFile(path)
	if err != nil || validateUniqueJSONKeys(raw) != nil {
		return nil, errors.New("community outbound replay state is invalid")
	}
	var document communityOutboundReplayDocument
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&document) != nil || ensureJSONEOF(decoder) != nil ||
		document.SchemaVersion != communityOutboundStateVersion || len(document.Entries) > 4096 {
		return nil, errors.New("community outbound replay state is invalid")
	}
	for attemptID, entry := range document.Entries {
		if !communityInferenceIdentifier.MatchString(attemptID) || !communityInferenceDigest.MatchString(entry.RequestDigest) {
			return nil, errors.New("community outbound replay state is invalid")
		}
		if _, err := canonicalTimestamp(entry.ExpiresAt); err != nil {
			return nil, errors.New("community outbound replay state is invalid")
		}
	}
	store.entries = document.Entries
	return store, nil
}

func (store *communityOutboundReplayStore) begin(attemptID, requestDigest string, expiresAt time.Time, now time.Time) (bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	for key, entry := range store.entries {
		expiry, err := canonicalTimestamp(entry.ExpiresAt)
		if err != nil || !expiry.After(now) {
			delete(store.entries, key)
		}
	}
	if existing, found := store.entries[attemptID]; found {
		if existing.RequestDigest != requestDigest {
			return false, errors.New("community outbound replay digest conflicts")
		}
		return false, nil
	}
	if len(store.entries) >= 4096 {
		return false, errors.New("community outbound replay state is full")
	}
	store.entries[attemptID] = communityOutboundReplayEntry{
		RequestDigest: requestDigest,
		ExpiresAt:     expiresAt.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z"),
	}
	document := communityOutboundReplayDocument{SchemaVersion: communityOutboundStateVersion, Entries: store.entries}
	encoded, err := json.Marshal(document)
	if err != nil || len(encoded) > 1024*1024 || atomicWrite0600(store.path, append(encoded, '\n')) != nil {
		delete(store.entries, attemptID)
		return false, errors.New("community outbound replay state cannot be persisted")
	}
	return true, nil
}

type communityOutboundWorker struct {
	baseURL    *url.URL
	cloud      *http.Client
	sessions   *communityOutboundSessionStore
	enrollment *cloudEnrollmentStore
	policy     *capacityPolicyStore
	backend    communityOutboundExecutionBackend
	catalog    []communityModelBinding
	trusted    trustedProviderDemandKeys
	replay     *communityOutboundReplayStore
	now        func() time.Time
	stats      *communityOutboundWorkerStats
}

// communityOutboundExecutionBackend is intentionally narrower than the full
// managed lifecycle contract. A discovered OpenAI-compatible endpoint does not
// qualify: a backend must be compiled, identify the signed demand runtime, and
// provide the reviewed canonical-model mapping and bounded execution methods.
type communityModelBinding struct {
	CanonicalModelID string
	UpstreamModel    string
	ContentDigest    string
	RuntimeID        string
}

func validateCommunityBindings(runtimeID string, bindings []communityModelBinding) error {
	if runtimeID == "" || len(bindings) == 0 || len(bindings) > maximumProviderDemandItems {
		return errors.New("invalid community bindings")
	}
	seen := make(map[string]bool)
	for _, binding := range bindings {
		if binding.RuntimeID != runtimeID || !providerDemandModelID.MatchString(binding.CanonicalModelID) ||
			!communityInferenceIdentifier.MatchString(binding.UpstreamModel) || !providerDemandContentDigest.MatchString(binding.ContentDigest) || seen[binding.CanonicalModelID] {
			return errors.New("invalid community binding")
		}
		seen[binding.CanonicalModelID] = true
	}
	return nil
}

type communityOutboundExecutionBackend interface {
	CommunityRuntimeID() string
	CommunityCatalog() []communityModelBinding
	Execute(context.Context, runtimeExecuteRequest) (runtimeExecuteResult, error)
	ExecuteStream(context.Context, runtimeExecuteRequest, func(runtimeExecuteChunk) error) (runtimeExecutionSummary, error)
}

func communityBackendForRuntime(runtimeID string, backends ...communityOutboundExecutionBackend) (communityOutboundExecutionBackend, error) {
	if runtimeID == "" || len(backends) < 1 || len(backends) > 32 {
		return nil, errors.New("community outbound runtime backend is unavailable")
	}
	var selected communityOutboundExecutionBackend
	for _, backend := range backends {
		if backend == nil || backend.CommunityRuntimeID() == "" {
			return nil, errors.New("community outbound runtime backend is invalid")
		}
		if backend.CommunityRuntimeID() == runtimeID {
			if selected != nil {
				return nil, errors.New("community outbound runtime backend is ambiguous")
			}
			selected = backend
		}
	}
	if selected == nil {
		return nil, errors.New("community outbound runtime backend is unavailable")
	}
	return selected, nil
}

type communityOutboundWorkerStatus struct {
	SchemaVersion      string `json:"schema_version"`
	Claims             uint64 `json:"claims"`
	Executions         uint64 `json:"executions"`
	RenewFailures      uint64 `json:"renew_failures"`
	Cancellations      uint64 `json:"cancellations"`
	StreamFailures     uint64 `json:"stream_failures"`
	CompletionFailures uint64 `json:"completion_failures"`
	LastClaimedAt      string `json:"last_claimed_at,omitempty"`
	LastCompletedAt    string `json:"last_completed_at,omitempty"`
	LastErrorCategory  string `json:"last_error_category,omitempty"`
}

type communityOutboundWorkerStats struct {
	mu     sync.Mutex
	status communityOutboundWorkerStatus
}

func newCommunityOutboundWorkerStats() *communityOutboundWorkerStats {
	return &communityOutboundWorkerStats{status: communityOutboundWorkerStatus{SchemaVersion: "community-outbound-worker-status-v1"}}
}

func (stats *communityOutboundWorkerStats) update(effect func(*communityOutboundWorkerStatus)) {
	stats.mu.Lock()
	defer stats.mu.Unlock()
	effect(&stats.status)
}

func (stats *communityOutboundWorkerStats) snapshot() communityOutboundWorkerStatus {
	stats.mu.Lock()
	defer stats.mu.Unlock()
	return stats.status
}

func newCommunityOutboundWorker(
	baseURL *url.URL,
	client *http.Client,
	sessions *communityOutboundSessionStore,
	enrollment *cloudEnrollmentStore,
	policy *capacityPolicyStore,
	backend communityOutboundExecutionBackend,
	authorizedRuntime string,
	trusted trustedProviderDemandKeys,
	replay *communityOutboundReplayStore,
) (*communityOutboundWorker, error) {
	if baseURL == nil || sessions == nil || enrollment == nil || policy == nil || backend == nil || replay == nil || len(trusted) < 1 ||
		client == nil || backend.CommunityRuntimeID() != authorizedRuntime {
		return nil, errors.New("community outbound worker configuration is incomplete")
	}
	catalog := backend.CommunityCatalog()
	if validateCommunityBindings(authorizedRuntime, catalog) != nil {
		return nil, errors.New("community outbound worker backend catalog is invalid")
	}
	cloud := *client
	cloud.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	cloud.Timeout = 10 * time.Second
	keys := make(trustedProviderDemandKeys, len(trusted))
	for keyID, key := range trusted {
		keys[keyID] = append(ed25519.PublicKey(nil), key...)
	}
	return &communityOutboundWorker{
		baseURL: baseURL, cloud: &cloud, sessions: sessions, enrollment: enrollment, policy: policy,
		backend: backend, catalog: append([]communityModelBinding{}, catalog...), trusted: keys, replay: replay, now: time.Now,
		stats: newCommunityOutboundWorkerStats(),
	}, nil
}

func (worker *communityOutboundWorker) status() communityOutboundWorkerStatus {
	if worker == nil || worker.stats == nil {
		return communityOutboundWorkerStatus{SchemaVersion: "community-outbound-worker-status-v1"}
	}
	return worker.stats.snapshot()
}

func communityInferencePayloadMap(payload communityInferencePayload) map[string]any {
	return map[string]any{
		"kind": payload.Kind, "protocolVersion": payload.ProtocolVersion,
		"canonicalizationVersion": payload.CanonicalizationVersion, "requestId": payload.RequestID,
		"attemptId": payload.AttemptID, "routeId": payload.RouteID, "providerId": payload.ProviderID,
		"model": payload.Model, "upstreamModel": payload.UpstreamModel, "protocol": payload.Protocol,
		"operation": payload.Operation, "path": payload.Path, "stream": payload.Stream,
		"requestDigest": payload.RequestDigest, "bodyDigest": payload.BodyDigest, "bodyBytes": payload.BodyBytes,
		"nonce": payload.Nonce, "issuedAt": payload.IssuedAt, "expiresAt": payload.ExpiresAt,
	}
}

func unsignedCommunityInferenceMap(envelope signedCommunityInferenceRequest) map[string]any {
	return map[string]any{
		"envelopeVersion": envelope.EnvelopeVersion, "kind": envelope.Kind,
		"payload":   communityInferencePayloadMap(envelope.Payload),
		"signature": map[string]any{"algorithm": envelope.Signature.Algorithm, "keyId": envelope.Signature.KeyID},
	}
}

func communityRequestDigest(protocol, operation, path string, body []byte) string {
	digest := sha256.New()
	_, _ = digest.Write([]byte("multivibe-community-request-v1\x00"))
	_, _ = digest.Write([]byte(protocol))
	_, _ = digest.Write([]byte{0})
	_, _ = digest.Write([]byte(operation))
	_, _ = digest.Write([]byte{0})
	_, _ = digest.Write([]byte(path))
	_, _ = digest.Write([]byte{0})
	_, _ = digest.Write(body)
	return hex.EncodeToString(digest.Sum(nil))
}

func validCommunityOperation(operation, path string) bool {
	allowed := map[string]string{
		"responses": "/v1/responses", "chat_completions": "/v1/chat/completions",
		"embeddings": "/v1/embeddings", "rerank": "/v1/rerank",
		"image_generation": "/v1/images/generations", "audio_transcription": "/v1/audio/transcriptions",
		"audio_translation": "/v1/audio/translations", "audio_speech": "/v1/audio/speech",
	}
	return allowed[operation] == strings.SplitN(path, "?", 2)[0]
}

func (worker *communityOutboundWorker) catalogModel(model, upstream string) (string, bool) {
	if strings.HasPrefix(model, "multivibe/") || !strings.Contains(model, "/") || !validSelectedModelID(model) {
		return "", false
	}
	for _, entry := range worker.catalog {
		if (entry.CanonicalModelID == "hf:"+model || entry.CanonicalModelID == "openrouter:"+model) && entry.UpstreamModel == upstream {
			return entry.CanonicalModelID, true
		}
	}
	return "", false
}

func (worker *communityOutboundWorker) verify(claim communityOutboundClaim, now time.Time) ([]byte, string, error) {
	if !communityInferenceUUID.MatchString(claim.JobID) || !communityInferenceUUID.MatchString(claim.LeaseID) {
		return nil, "", errors.New("community outbound claim identity is invalid")
	}
	leaseExpiry, leaseErr := canonicalTimestamp(claim.LeaseExpiresAt)
	envelope := claim.Wire.Envelope
	payload := envelope.Payload
	issuedAt, issuedErr := canonicalTimestamp(payload.IssuedAt)
	expiresAt, expiresErr := canonicalTimestamp(payload.ExpiresAt)
	nonce, nonceErr := base64.RawURLEncoding.DecodeString(payload.Nonce)
	if leaseErr != nil || issuedErr != nil || expiresErr != nil || !leaseExpiry.After(now) ||
		envelope.EnvelopeVersion != communityInferenceEnvelope || envelope.Kind != "inference_request" || payload.Kind != envelope.Kind ||
		payload.ProtocolVersion != communityInferenceProtocol || payload.CanonicalizationVersion != relayCanonicalization ||
		!communityInferenceIdentifier.MatchString(payload.RequestID) || !communityInferenceIdentifier.MatchString(payload.AttemptID) ||
		!communityInferenceIdentifier.MatchString(payload.RouteID) || !communityInferenceProviderID.MatchString(payload.ProviderID) ||
		payload.Protocol != "openai" || !validCommunityOperation(payload.Operation, payload.Path) ||
		!communityInferenceDigest.MatchString(payload.RequestDigest) || !communityInferenceDigest.MatchString(payload.BodyDigest) ||
		payload.BodyBytes < 1 || payload.BodyBytes > communityInferenceMaximumBody || nonceErr != nil || len(nonce) != 32 ||
		base64.RawURLEncoding.EncodeToString(nonce) != payload.Nonce || issuedAt.After(now.Add(5*time.Second)) ||
		!expiresAt.After(now) || !expiresAt.After(issuedAt) || expiresAt.Sub(issuedAt) > 30*time.Second ||
		envelope.Signature.Algorithm != relaySignatureAlgorithm || !providerDemandKeyID.MatchString(envelope.Signature.KeyID) {
		return nil, "", errors.New("community inference request is invalid")
	}
	enrollment := worker.enrollment.snapshot()
	if enrollment == nil || enrollment.ProviderID != payload.ProviderID {
		return nil, "", errors.New("community inference provider binding is invalid")
	}
	canonicalModel, found := worker.catalogModel(payload.Model, payload.UpstreamModel)
	if !found {
		return nil, "", errors.New("community inference model binding is invalid")
	}
	body, err := base64.RawURLEncoding.DecodeString(claim.Wire.Body)
	if err != nil || base64.RawURLEncoding.EncodeToString(body) != claim.Wire.Body || uint64(len(body)) != payload.BodyBytes {
		return nil, "", errors.New("community inference body is invalid")
	}
	bodyDigest := sha256.Sum256(body)
	if hex.EncodeToString(bodyDigest[:]) != payload.BodyDigest || communityRequestDigest(payload.Protocol, payload.Operation, payload.Path, body) != payload.RequestDigest ||
		validateUniqueJSONKeys(body) != nil {
		return nil, "", errors.New("community inference body digest is invalid")
	}
	var requestBody map[string]json.RawMessage
	if json.Unmarshal(body, &requestBody) != nil || requestBody == nil {
		return nil, "", errors.New("community inference body is invalid")
	}
	var bodyModel string
	if json.Unmarshal(requestBody["model"], &bodyModel) != nil || bodyModel != payload.UpstreamModel {
		return nil, "", errors.New("community inference body model is invalid")
	}
	publicKey, found := worker.trusted[envelope.Signature.KeyID]
	signature, signatureErr := base64.RawURLEncoding.DecodeString(envelope.Signature.Value)
	canonical, canonicalErr := canonicalJSON(unsignedCommunityInferenceMap(envelope), 64*1024)
	if !found || signatureErr != nil || len(signature) != ed25519.SignatureSize ||
		base64.RawURLEncoding.EncodeToString(signature) != envelope.Signature.Value || canonicalErr != nil ||
		!ed25519.Verify(publicKey, append(append([]byte{}, communityInferenceSigningDomain...), canonical...), signature) {
		return nil, "", errors.New("community inference signature is invalid")
	}
	return body, canonicalModel, nil
}

func (worker *communityOutboundWorker) authorized() bool {
	policy := worker.policy.snapshot()
	return policy != nil && policy.Paused != nil && !*policy.Paused &&
		policy.AllowCloudWorkloads != nil && *policy.AllowCloudWorkloads
}

func (worker *communityOutboundWorker) post(ctx context.Context, session *communityOutboundSession, path string, value any) (int, []byte, error) {
	body, err := json.Marshal(value)
	if err != nil || len(body) > communityOutboundMaximumPost {
		return 0, nil, errors.New("community outbound request cannot be encoded")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, worker.baseURL.String()+path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, errors.New("community outbound request is invalid")
	}
	request.Header.Set("authorization", "Bearer "+session.Token)
	request.Header.Set("content-type", "application/json")
	request.Header.Set("accept", "application/json")
	response, err := worker.cloud.Do(request)
	if err != nil {
		return 0, nil, errors.New("community outbound Cloud request failed")
	}
	defer response.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, 64*1024+1))
	if readErr != nil || len(raw) > 64*1024 {
		return response.StatusCode, nil, errors.New("community outbound Cloud response is invalid")
	}
	return response.StatusCode, raw, nil
}

func (worker *communityOutboundWorker) claim(ctx context.Context, session *communityOutboundSession) (*communityOutboundClaim, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, worker.baseURL.String()+"/provider/v1/inference-jobs/claim", strings.NewReader("{}"))
	if err != nil {
		return nil, err
	}
	request.Header.Set("authorization", "Bearer "+session.Token)
	request.Header.Set("content-type", "application/json")
	request.Header.Set("accept", "application/json")
	response, err := worker.cloud.Do(request)
	if err != nil {
		return nil, errors.New("community outbound claim request failed")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNoContent {
		return nil, nil
	}
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, communityInferenceMaximumWire+1))
	if readErr != nil || response.StatusCode != http.StatusOK || len(raw) < 1 || len(raw) > communityInferenceMaximumWire || validateUniqueJSONKeys(raw) != nil {
		return nil, errors.New("community outbound claim was rejected")
	}
	var claim communityOutboundClaim
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&claim) != nil || ensureJSONEOF(decoder) != nil {
		return nil, errors.New("community outbound claim is invalid")
	}
	return &claim, nil
}

func (worker *communityOutboundWorker) cancelled(ctx context.Context, session *communityOutboundSession, claim communityOutboundClaim) bool {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, worker.baseURL.String()+"/provider/v1/inference-jobs/"+claim.JobID+"/cancellation", nil)
	if err != nil {
		return true
	}
	request.Header.Set("authorization", "Bearer "+session.Token)
	request.Header.Set("x-multivibe-lease-id", claim.LeaseID)
	response, err := worker.cloud.Do(request)
	if err != nil {
		return true
	}
	defer response.Body.Close()
	var result struct {
		Cancelled bool `json:"cancelled"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 1025))
	decoder.DisallowUnknownFields()
	return response.StatusCode != http.StatusOK || decoder.Decode(&result) != nil || ensureJSONEOF(decoder) != nil || result.Cancelled
}

func (worker *communityOutboundWorker) renew(ctx context.Context, session *communityOutboundSession, claim communityOutboundClaim) error {
	status, _, err := worker.post(ctx, session, "/provider/v1/inference-jobs/"+claim.JobID+"/renew", map[string]any{"leaseId": claim.LeaseID})
	if err != nil || status != http.StatusOK {
		return errors.New("community outbound lease cannot be renewed")
	}
	return nil
}

func communityOutboundErrorResponse(disposition string) (int, map[string]string, []byte, string) {
	status := http.StatusBadGateway
	if disposition == "not_executed" {
		status = http.StatusServiceUnavailable
	}
	body := []byte(`{"error":{"code":"community_inference_backend_failed"}}`)
	return status, map[string]string{"content-type": "application/json; charset=utf-8"}, body, disposition
}

func (worker *communityOutboundWorker) complete(ctx context.Context, claim communityOutboundClaim, status int, headers map[string]string, body []byte, disposition string) error {
	deadline := worker.now().Add(10 * time.Minute)
	for ctx.Err() == nil && worker.now().Before(deadline) {
		session := worker.sessions.snapshot(worker.now())
		if session == nil {
			if !waitWorkerTest(ctx, 250*time.Millisecond) {
				break
			}
			continue
		}
		code, _, err := worker.post(ctx, session, "/provider/v1/inference-jobs/"+claim.JobID+"/complete", map[string]any{
			"leaseId": claim.LeaseID, "status": status, "headers": headers,
			"body": base64.RawURLEncoding.EncodeToString(body), "disposition": disposition,
		})
		if err == nil && (code == http.StatusCreated || code == http.StatusOK) {
			worker.stats.update(func(value *communityOutboundWorkerStatus) {
				value.LastCompletedAt = worker.now().UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
			})
			return nil
		}
		if code >= 400 && code < 500 && code != http.StatusUnauthorized {
			return errors.New("community outbound completion was rejected")
		}
		if !waitWorkerTest(ctx, 500*time.Millisecond) {
			break
		}
	}
	worker.stats.update(func(value *communityOutboundWorkerStatus) {
		value.CompletionFailures++
		value.LastErrorCategory = "completion_failed"
	})
	return errors.New("community outbound completion could not be committed")
}

func (worker *communityOutboundWorker) appendChunk(ctx context.Context, claim communityOutboundClaim, sequence int, chunk []byte, final bool) error {
	if len(chunk) < 1 || len(chunk) > communityInferenceMaximumChunk {
		return errors.New("community outbound stream chunk is invalid")
	}
	for attempts := 0; attempts < 20 && ctx.Err() == nil; attempts++ {
		session := worker.sessions.snapshot(worker.now())
		if session != nil {
			status, _, err := worker.post(ctx, session, "/provider/v1/inference-jobs/"+claim.JobID+"/chunks", map[string]any{
				"leaseId": claim.LeaseID, "sequence": sequence, "body": base64.RawURLEncoding.EncodeToString(chunk),
				"final": final, "status": http.StatusOK, "headers": map[string]string{"content-type": "text/event-stream"},
				"disposition": "executed",
			})
			if err == nil && (status == http.StatusCreated || status == http.StatusOK) {
				return nil
			}
			if status >= 400 && status < 500 && status != http.StatusUnauthorized {
				return errors.New("community outbound stream chunk was rejected")
			}
		}
		if !waitWorkerTest(ctx, 250*time.Millisecond) {
			break
		}
	}
	worker.stats.update(func(value *communityOutboundWorkerStatus) {
		value.StreamFailures++
		value.LastErrorCategory = "stream_commit_failed"
	})
	return errors.New("community outbound stream chunk could not be committed")
}

func (worker *communityOutboundWorker) monitor(ctx context.Context, cancel context.CancelFunc, claim communityOutboundClaim, done <-chan struct{}) {
	ticker := time.NewTicker(4 * time.Second)
	defer ticker.Stop()
	failures := 0
	for {
		select {
		case <-done:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			if !worker.authorized() {
				worker.stats.update(func(value *communityOutboundWorkerStatus) { value.Cancellations++ })
				cancel()
				return
			}
			session := worker.sessions.snapshot(worker.now())
			cancelled := session != nil && worker.cancelled(ctx, session, claim)
			renewFailed := session == nil || (!cancelled && worker.renew(ctx, session, claim) != nil)
			if cancelled || renewFailed {
				worker.stats.update(func(value *communityOutboundWorkerStatus) {
					if cancelled {
						value.Cancellations++
					} else {
						value.RenewFailures++
						value.LastErrorCategory = "renew_failed"
					}
				})
				failures++
				if failures >= 3 {
					cancel()
					return
				}
			} else {
				failures = 0
			}
		}
	}
}

func (worker *communityOutboundWorker) execute(ctx context.Context, claim communityOutboundClaim) {
	worker.stats.update(func(value *communityOutboundWorkerStatus) { value.Executions++ })
	now := worker.now().UTC()
	body, modelID, err := worker.verify(claim, now)
	if err != nil || !worker.authorized() {
		status, headers, responseBody, disposition := communityOutboundErrorResponse("not_executed")
		_ = worker.complete(ctx, claim, status, headers, responseBody, disposition)
		return
	}
	expiresAt, _ := canonicalTimestamp(claim.Wire.Envelope.Payload.ExpiresAt)
	first, err := worker.replay.begin(claim.Wire.Envelope.Payload.AttemptID, claim.Wire.Envelope.Payload.RequestDigest, expiresAt.Add(24*time.Hour), now)
	if err != nil || !first {
		status, headers, responseBody, disposition := communityOutboundErrorResponse("uncertain")
		_ = worker.complete(ctx, claim, status, headers, responseBody, disposition)
		return
	}
	executionContext, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go worker.monitor(executionContext, cancel, claim, done)
	defer func() {
		close(done)
		cancel()
	}()
	request := runtimeExecuteRequest{
		ExecutionID: claim.JobID, ModelID: modelID, Input: body, MaximumOutput: communityInferenceMaximumResponse,
	}
	if claim.Wire.Envelope.Payload.Stream {
		sequence := 0
		_, executeErr := worker.backend.ExecuteStream(executionContext, request, func(chunk runtimeExecuteChunk) error {
			if err := worker.appendChunk(executionContext, claim, sequence, chunk.Output, chunk.Final); err != nil {
				return err
			}
			sequence++
			return nil
		})
		if executeErr == nil {
			return
		}
		worker.stats.update(func(value *communityOutboundWorkerStatus) {
			value.StreamFailures++
			value.LastErrorCategory = "backend_stream_failed"
		})
		if sequence == 0 {
			status, headers, responseBody, disposition := communityOutboundErrorResponse("uncertain")
			_ = worker.complete(ctx, claim, status, headers, responseBody, disposition)
		} else {
			// Once streaming has started the Cloud reader waits for a terminal
			// chunk. Surface the backend failure in-band and close the stream.
			errorEvent := []byte("event: error\ndata: {\"error\":{\"code\":\"community_inference_backend_failed\"}}\n\n")
			_ = worker.appendChunk(ctx, claim, sequence, errorEvent, true)
		}
		return
	}
	result, executeErr := worker.backend.Execute(executionContext, request)
	if executeErr != nil {
		disposition := "uncertain"
		if errors.Is(executeErr, errRuntimeBackendIncompatible) || errors.Is(executeErr, errRuntimeBackendInvalid) {
			disposition = "not_executed"
		}
		status, headers, responseBody, disposition := communityOutboundErrorResponse(disposition)
		_ = worker.complete(ctx, claim, status, headers, responseBody, disposition)
		return
	}
	_ = worker.complete(ctx, claim, http.StatusOK, map[string]string{"content-type": "application/json"}, result.Output, "executed")
}

func (worker *communityOutboundWorker) run(ctx context.Context) {
	for ctx.Err() == nil {
		session := worker.sessions.snapshot(worker.now())
		if session == nil || !worker.authorized() {
			if !waitWorkerTest(ctx, time.Second) {
				return
			}
			continue
		}
		claim, err := worker.claim(ctx, session)
		if err != nil || claim == nil {
			wait := time.Duration(session.PollAfterMS) * time.Millisecond
			if err != nil {
				wait = time.Second
			}
			if !waitWorkerTest(ctx, wait) {
				return
			}
			continue
		}
		worker.stats.update(func(value *communityOutboundWorkerStatus) {
			value.Claims++
			value.LastClaimedAt = worker.now().UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
		})
		worker.execute(ctx, *claim)
	}
}
