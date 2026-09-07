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
	"sort"
	"sync"
	"time"
)

const (
	providerModelLifecycleProtocol        = "multivibe-provider-model-lifecycle-v1"
	providerModelInventoryEnvelopeVersion = "multivibe-provider-model-inventory-envelope-v1"
	providerModelInventoryMaximumBytes    = 256 * 1024
	providerModelInventoryDefaultInterval = 30 * time.Second
	providerModelInventorySigningDomain   = "MultiVibe Provider Model Inventory\x00multivibe-provider-model-lifecycle-v1\x00signed-envelope-v1\x00"
)

type providerModelInventoryItem struct {
	ReportedID       string   `json:"reportedId"`
	Modalities       []string `json:"modalities"`
	ContentDigest    *string  `json:"contentDigest"`
	ArtifactVerified bool     `json:"artifactVerified"`
}

type providerModelInventoryRuntime struct {
	RuntimeFamily string                       `json:"runtimeFamily"`
	Models        []providerModelInventoryItem `json:"models"`
}

type providerModelInventoryDiagnostic struct {
	RuntimeFamily string `json:"runtimeFamily"`
	Status        string `json:"status"`
	Code          string `json:"code"`
}

type providerModelInventoryPayload struct {
	Kind                    string                             `json:"kind"`
	ProtocolVersion         string                             `json:"protocolVersion"`
	CanonicalizationVersion string                             `json:"canonicalizationVersion"`
	ProviderID              string                             `json:"providerId"`
	NodeID                  string                             `json:"nodeId"`
	DeviceKeyID             string                             `json:"deviceKeyId"`
	CredentialEpoch         uint64                             `json:"credentialEpoch"`
	Generation              uint64                             `json:"generation"`
	MaxConcurrency          uint64                             `json:"maxConcurrency"`
	AvailableConcurrency    uint64                             `json:"availableConcurrency"`
	ObservedAt              string                             `json:"observedAt"`
	IssuedAt                string                             `json:"issuedAt"`
	ExpiresAt               string                             `json:"expiresAt"`
	Runtimes                []providerModelInventoryRuntime    `json:"runtimes"`
	Diagnostics             []providerModelInventoryDiagnostic `json:"diagnostics"`
}

type signedProviderModelInventory struct {
	EnvelopeVersion string                        `json:"envelopeVersion"`
	Kind            string                        `json:"kind"`
	Payload         providerModelInventoryPayload `json:"payload"`
	Signature       providerControlSignature      `json:"signature"`
}

func providerModelInventoryPayloadMap(payload providerModelInventoryPayload) map[string]any {
	runtimes := make([]any, 0, len(payload.Runtimes))
	for _, runtime := range payload.Runtimes {
		models := make([]any, 0, len(runtime.Models))
		for _, model := range runtime.Models {
			var contentDigest any
			if model.ContentDigest != nil {
				contentDigest = *model.ContentDigest
			}
			models = append(models, map[string]any{
				"reportedId": model.ReportedID, "modalities": stringsToAny(model.Modalities),
				"contentDigest": contentDigest, "artifactVerified": model.ArtifactVerified,
			})
		}
		runtimes = append(runtimes, map[string]any{"runtimeFamily": runtime.RuntimeFamily, "models": models})
	}
	diagnostics := make([]any, 0, len(payload.Diagnostics))
	for _, diagnostic := range payload.Diagnostics {
		diagnostics = append(diagnostics, map[string]any{
			"runtimeFamily": diagnostic.RuntimeFamily, "status": diagnostic.Status, "code": diagnostic.Code,
		})
	}
	return map[string]any{
		"kind": payload.Kind, "protocolVersion": payload.ProtocolVersion,
		"canonicalizationVersion": payload.CanonicalizationVersion, "providerId": payload.ProviderID,
		"nodeId": payload.NodeID, "deviceKeyId": payload.DeviceKeyID, "credentialEpoch": payload.CredentialEpoch,
		"generation": payload.Generation, "maxConcurrency": payload.MaxConcurrency,
		"availableConcurrency": payload.AvailableConcurrency, "observedAt": payload.ObservedAt,
		"issuedAt": payload.IssuedAt, "expiresAt": payload.ExpiresAt,
		"runtimes": runtimes, "diagnostics": diagnostics,
	}
}

func stringsToAny(values []string) []any {
	result := make([]any, len(values))
	for index, value := range values {
		result[index] = value
	}
	return result
}

type providerModelAdmissionStatus struct {
	RuntimeFamily    string `json:"runtimeFamily"`
	ReportedModelID  string `json:"reportedModelId"`
	CanonicalModelID string `json:"canonicalModelId,omitempty"`
	State            string `json:"state"`
	ReasonCode       string `json:"reasonCode"`
	UpdatedAt        string `json:"updatedAt"`
}

type providerModelLifecycleResponse struct {
	ProtocolVersion        string                         `json:"protocolVersion"`
	NodeID                 string                         `json:"nodeId"`
	InventoryGeneration    uint64                         `json:"inventoryGeneration"`
	InventoryAccepted      bool                           `json:"inventoryAccepted"`
	Replay                 bool                           `json:"replay"`
	NextReportAfterSeconds uint64                         `json:"nextReportAfterSeconds"`
	Admissions             []providerModelAdmissionStatus `json:"admissions"`
	DemandEnvelope         json.RawMessage                `json:"demandEnvelope,omitempty"`
	RelaySession           *communityOutboundSession      `json:"relaySession,omitempty"`
}

type communityOutboundSession struct {
	Token       string `json:"token"`
	ExpiresAt   string `json:"expiresAt"`
	PollAfterMS uint64 `json:"pollAfterMs"`
}

type communityOutboundSessionStore struct {
	mu      sync.RWMutex
	session *communityOutboundSession
}

func (store *communityOutboundSessionStore) replace(session *communityOutboundSession, now time.Time) error {
	if session == nil {
		store.mu.Lock()
		store.session = nil
		store.mu.Unlock()
		return nil
	}
	expiresAt, err := canonicalTimestamp(session.ExpiresAt)
	decoded, decodeErr := base64.RawURLEncoding.DecodeString(session.Token)
	if err != nil || decodeErr != nil || len(decoded) != 32 || base64.RawURLEncoding.EncodeToString(decoded) != session.Token ||
		session.PollAfterMS < 50 || session.PollAfterMS > 10_000 || !expiresAt.After(now) || expiresAt.Sub(now) > 2*time.Minute {
		return errors.New("provider model lifecycle relay session is invalid")
	}
	copy := *session
	store.mu.Lock()
	store.session = &copy
	store.mu.Unlock()
	return nil
}

func (store *communityOutboundSessionStore) snapshot(now time.Time) *communityOutboundSession {
	store.mu.RLock()
	defer store.mu.RUnlock()
	if store.session == nil {
		return nil
	}
	expiresAt, err := canonicalTimestamp(store.session.ExpiresAt)
	if err != nil || !expiresAt.After(now) {
		return nil
	}
	copy := *store.session
	return &copy
}

type providerModelLifecycleStatus struct {
	SchemaVersion       string `json:"schema_version"`
	State               string `json:"state"`
	InventoryGeneration uint64 `json:"inventory_generation"`
	LastReportedAt      string `json:"last_reported_at,omitempty"`
	LastSuccessAt       string `json:"last_success_at,omitempty"`
	LastErrorCode       string `json:"last_error_code,omitempty"`
	AdmissionCount      int    `json:"admission_count"`
	PlanGeneration      uint64 `json:"plan_generation"`
	AppliedGeneration   uint64 `json:"applied_generation"`
	AutomaticReconcile  bool   `json:"automatic_reconcile"`
}

type providerModelLifecycleService struct {
	baseURL    *url.URL
	cloud      *http.Client
	identity   *deviceIdentity
	enrollment *cloudEnrollmentStore
	capacity   *capacityPolicyStore
	demand     *providerDemandService
	controller *managedProviderController
	relay      *communityOutboundSessionStore
	now        func() time.Time

	mu     sync.Mutex
	status providerModelLifecycleStatus
}

func newProviderModelLifecycleService(
	baseURL *url.URL,
	client *http.Client,
	identity *deviceIdentity,
	enrollment *cloudEnrollmentStore,
	capacity *capacityPolicyStore,
	demand *providerDemandService,
	controller *managedProviderController,
) *providerModelLifecycleService {
	cloud := *client
	cloud.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	cloud.Timeout = 15 * time.Second
	return &providerModelLifecycleService{
		baseURL: baseURL, cloud: &cloud, identity: identity, enrollment: enrollment,
		capacity: capacity, demand: demand, controller: controller,
		relay: &communityOutboundSessionStore{}, now: time.Now,
		status: providerModelLifecycleStatus{SchemaVersion: "provider-model-lifecycle-status-v1", State: "waiting_for_enrollment"},
	}
}

func (service *providerModelLifecycleService) snapshot() providerModelLifecycleStatus {
	service.mu.Lock()
	defer service.mu.Unlock()
	return service.status
}

func (service *providerModelLifecycleService) updateStatus(update func(*providerModelLifecycleStatus)) {
	service.mu.Lock()
	defer service.mu.Unlock()
	update(&service.status)
}

func (service *providerModelLifecycleService) inventoryRuntimes(
	policy *capacityPolicyStateDocument,
) []providerModelInventoryRuntime {
	byRuntime := make(map[string]map[string]providerModelInventoryItem)
	// User-configured runtimes are local inference facilities, never Cloud
	// worker inventory. Only the managed runtime may be advertised, and only
	// after the operator's capacity policy explicitly authorizes Cloud work.
	if service.controller != nil && service.demand != nil && managedControllerPolicyConsented(policy) {
		if managed, err := service.controller.runtime.managedInventory(policy); err == nil {
			models := byRuntime["ollama"]
			if models == nil {
				models = make(map[string]providerModelInventoryItem)
				byRuntime["ollama"] = models
			}
			for _, modelID := range managed {
				entry, exists := service.demand.catalog.entry(modelID)
				if !exists {
					continue
				}
				digest := entry.ContentDigest
				models[modelID] = providerModelInventoryItem{
					ReportedID: modelID, Modalities: []string{"text"}, ContentDigest: &digest, ArtifactVerified: true,
				}
			}
		}
	}
	runtimeIDs := make([]string, 0, len(byRuntime))
	for runtimeID := range byRuntime {
		runtimeIDs = append(runtimeIDs, runtimeID)
	}
	sort.Strings(runtimeIDs)
	result := make([]providerModelInventoryRuntime, 0, len(runtimeIDs))
	for _, runtimeID := range runtimeIDs {
		modelIDs := make([]string, 0, len(byRuntime[runtimeID]))
		for modelID := range byRuntime[runtimeID] {
			modelIDs = append(modelIDs, modelID)
		}
		sort.Strings(modelIDs)
		models := make([]providerModelInventoryItem, 0, len(modelIDs))
		for _, modelID := range modelIDs {
			models = append(models, byRuntime[runtimeID][modelID])
		}
		result = append(result, providerModelInventoryRuntime{RuntimeFamily: runtimeID, Models: models})
	}
	return result
}

func (service *providerModelLifecycleService) signInventory(
	enrollment cloudEnrollmentView,
	policy *capacityPolicyStateDocument,
) (signedProviderModelInventory, error) {
	now := service.now().UTC().Truncate(time.Millisecond)
	runtimes := service.inventoryRuntimes(policy)
	availableConcurrency := uint64(0)
	if len(runtimes) > 0 {
		availableConcurrency = 1
	}
	service.identity.mu.Lock()
	defer service.identity.mu.Unlock()
	if service.identity.sequence >= maxRelaySequence {
		return signedProviderModelInventory{}, errors.New("provider model inventory sequence is exhausted")
	}
	service.identity.sequence++
	if service.identity.path != "" {
		if err := service.identity.persistLocked(); err != nil {
			service.identity.sequence--
			return signedProviderModelInventory{}, errors.New("provider model inventory sequence cannot be persisted")
		}
	}
	payload := providerModelInventoryPayload{
		Kind: "provider_model_inventory", ProtocolVersion: providerModelLifecycleProtocol,
		CanonicalizationVersion: relayCanonicalization, ProviderID: enrollment.ProviderID, NodeID: enrollment.NodeID,
		DeviceKeyID: enrollment.DeviceKeyID, CredentialEpoch: enrollment.CredentialEpoch,
		Generation: service.identity.sequence, MaxConcurrency: 1,
		AvailableConcurrency: availableConcurrency,
		ObservedAt:           now.Format("2006-01-02T15:04:05.000Z"), IssuedAt: now.Format("2006-01-02T15:04:05.000Z"),
		ExpiresAt: now.Add(time.Minute).Format("2006-01-02T15:04:05.000Z"),
		Runtimes:  runtimes, Diagnostics: []providerModelInventoryDiagnostic{},
	}
	unsigned := map[string]any{
		"envelopeVersion": providerModelInventoryEnvelopeVersion,
		"kind":            payload.Kind,
		"payload":         providerModelInventoryPayloadMap(payload),
		"signature": map[string]any{
			"algorithm": relaySignatureAlgorithm,
			"keyId":     enrollment.DeviceKeyID,
		},
	}
	canonical, err := canonicalJSON(unsigned, providerModelInventoryMaximumBytes)
	if err != nil {
		return signedProviderModelInventory{}, errors.New("provider model inventory cannot be encoded")
	}
	signature := ed25519.Sign(service.identity.privateKey, append([]byte(providerModelInventorySigningDomain), canonical...))
	return signedProviderModelInventory{
		EnvelopeVersion: providerModelInventoryEnvelopeVersion, Kind: payload.Kind, Payload: payload,
		Signature: providerControlSignature{Algorithm: relaySignatureAlgorithm, KeyID: enrollment.DeviceKeyID, Value: base64.RawURLEncoding.EncodeToString(signature)},
	}, nil
}

func (service *providerModelLifecycleService) submit(ctx context.Context, envelope signedProviderModelInventory) (providerModelLifecycleResponse, error) {
	body, err := json.Marshal(envelope)
	if err != nil || len(body) > providerModelInventoryMaximumBytes {
		return providerModelLifecycleResponse{}, errors.New("provider model inventory request is invalid")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, service.baseURL.String()+"/provider/v1/model-inventories", bytes.NewReader(body))
	if err != nil {
		return providerModelLifecycleResponse{}, errors.New("provider model inventory request is invalid")
	}
	request.Header.Set("accept", "application/json")
	request.Header.Set("content-type", "application/json")
	response, err := service.cloud.Do(request)
	if err != nil {
		return providerModelLifecycleResponse{}, errors.New("provider model inventory Cloud request failed")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return providerModelLifecycleResponse{}, errors.New("provider model inventory Cloud request was rejected")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, providerModelInventoryMaximumBytes+1))
	if err != nil || len(raw) > providerModelInventoryMaximumBytes || validateUniqueJSONKeys(raw) != nil {
		return providerModelLifecycleResponse{}, errors.New("provider model inventory Cloud response is invalid")
	}
	var result providerModelLifecycleResponse
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&result) != nil || ensureJSONEOF(decoder) != nil ||
		result.ProtocolVersion != providerModelLifecycleProtocol || result.NodeID != envelope.Payload.NodeID ||
		result.InventoryGeneration != envelope.Payload.Generation || !result.InventoryAccepted ||
		result.NextReportAfterSeconds < 5 || result.NextReportAfterSeconds > 300 || len(result.Admissions) > 1000 {
		return providerModelLifecycleResponse{}, errors.New("provider model inventory Cloud response is invalid")
	}
	if service.relay.replace(result.RelaySession, service.now().UTC()) != nil {
		return providerModelLifecycleResponse{}, errors.New("provider model inventory Cloud relay session is invalid")
	}
	return result, nil
}

func (service *providerModelLifecycleService) applyPlan(ctx context.Context, response providerModelLifecycleResponse) error {
	if len(response.DemandEnvelope) == 0 {
		return nil
	}
	if service.demand == nil {
		return nil
	}
	plan, _, err := service.demand.accept(response.DemandEnvelope)
	if err != nil {
		return err
	}
	service.updateStatus(func(status *providerModelLifecycleStatus) { status.PlanGeneration = plan.Generation })
	policy := service.capacity.snapshot()
	automatic := policy != nil && policy.Paused != nil && !*policy.Paused &&
		policy.AllowCloudWorkloads != nil && *policy.AllowCloudWorkloads &&
		policy.AutomaticDownloads != nil && *policy.AutomaticDownloads && service.controller != nil
	service.updateStatus(func(status *providerModelLifecycleStatus) { status.AutomaticReconcile = automatic })
	if !automatic {
		return nil
	}
	view, err := service.controller.reconcile(ctx, managedControllerFence{
		PolicyRevision: policy.Revision, PlanGeneration: plan.Generation, EnvelopeDigest: plan.EnvelopeDigest,
	})
	if err != nil {
		return err
	}
	service.updateStatus(func(status *providerModelLifecycleStatus) { status.AppliedGeneration = view.AppliedGeneration })
	return nil
}

func providerModelLifecycleErrorCode(err error) string {
	if err == nil {
		return ""
	}
	digest := sha256.Sum256([]byte(err.Error()))
	// Stable, bounded and non-sensitive. Detailed local/network errors never
	// enter the status document or Cloud inventory.
	return "operation_failed_" + hex.EncodeToString(digest[:4])
}

func (service *providerModelLifecycleService) run(ctx context.Context) {
	interval := providerModelInventoryDefaultInterval
	for {
		if ctx.Err() != nil {
			return
		}
		enrollment := service.enrollment.snapshot()
		if enrollment == nil {
			service.updateStatus(func(status *providerModelLifecycleStatus) { status.State = "waiting_for_enrollment" })
			if !waitWorkerTest(ctx, interval) {
				return
			}
			continue
		}
		policy := service.capacity.snapshot()
		envelope, err := service.signInventory(*enrollment, policy)
		now := service.now().UTC().Truncate(time.Millisecond)
		service.updateStatus(func(status *providerModelLifecycleStatus) {
			status.State = "reporting"
			status.InventoryGeneration = envelope.Payload.Generation
			status.LastReportedAt = now.Format("2006-01-02T15:04:05.000Z")
		})
		var response providerModelLifecycleResponse
		if err == nil {
			response, err = service.submit(ctx, envelope)
		}
		if err == nil {
			interval = time.Duration(response.NextReportAfterSeconds) * time.Second
			err = service.applyPlan(ctx, response)
		}
		if err != nil {
			_ = service.relay.replace(nil, now)
			service.updateStatus(func(status *providerModelLifecycleStatus) {
				status.State = "degraded"
				status.LastErrorCode = providerModelLifecycleErrorCode(err)
			})
		} else {
			service.updateStatus(func(status *providerModelLifecycleStatus) {
				status.State = "online"
				status.LastSuccessAt = service.now().UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
				status.LastErrorCode = ""
				status.AdmissionCount = len(response.Admissions)
			})
		}
		if !waitWorkerTest(ctx, interval) {
			return
		}
	}
}
