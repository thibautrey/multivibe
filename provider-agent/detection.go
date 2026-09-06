package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"time"
)

const detectedModelsSchemaVersion = "provider-detected-models-v2"

type detectedRuntime struct {
	AdapterID string   `json:"adapter_id"`
	Models    []string `json:"models"`
}

type detectedModelsDocument struct {
	SchemaVersion string                      `json:"schema_version"`
	ObservedAt    string                      `json:"observed_at"`
	Runtimes      []detectedRuntime           `json:"runtimes"`
	Diagnostics   []detectedRuntimeDiagnostic `json:"diagnostics"`
}

type detectedRuntimeDiagnostic struct {
	AdapterID string `json:"adapter_id"`
	Status    string `json:"status"`
	Code      string `json:"code"`
}

type modelCatalogPayload struct {
	Data []struct {
		ID      string `json:"id"`
		OwnedBy string `json:"owned_by"`
	} `json:"data"`
}

func automaticRuntimeOwner(adapterID string) string {
	switch adapterID {
	case "omlx", "mtplx", "exo":
		return adapterID
	default:
		return ""
	}
}

func detectedModels(ctx context.Context, registry adapterRegistryDocument, configured []runtimeEndpoint, client *http.Client) detectedModelsDocument {
	document := detectedModelsDocument{
		SchemaVersion: detectedModelsSchemaVersion,
		ObservedAt:    time.Now().UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z"),
		Runtimes:      []detectedRuntime{},
		Diagnostics:   []detectedRuntimeDiagnostic{},
	}
	for _, adapter := range registry.Adapters {
		if len(adapter.Candidates) == 0 {
			continue
		}
		available := false
		for _, candidate := range adapter.Candidates {
			models, err := probeRuntimeCatalogAuthenticated(ctx, adapter, candidate, "", client)
			if err != nil {
				continue
			}
			document.Runtimes = append(document.Runtimes, detectedRuntime{
				AdapterID: adapter.ID,
				Models:    models,
			})
			available = true
			break
		}
		if available {
			document.Diagnostics = append(document.Diagnostics, detectedRuntimeDiagnostic{AdapterID: adapter.ID, Status: "available", Code: "catalog_ok"})
		} else {
			document.Diagnostics = append(document.Diagnostics, detectedRuntimeDiagnostic{AdapterID: adapter.ID, Status: "unavailable", Code: "catalog_probe_failed"})
		}
	}
	adapters := make(map[string]runtimeAdapter, len(registry.Adapters))
	for _, adapter := range registry.Adapters {
		adapters[adapter.ID] = adapter
	}
	for _, endpoint := range configured {
		adapter, exists := adapters[endpoint.AdapterID]
		if !exists || len(adapter.Candidates) != 0 {
			continue
		}
		candidate := adapterCandidate{
			Endpoint:   endpoint.Endpoint,
			HealthURL:  endpoint.Endpoint + adapter.HealthPath,
			CatalogURL: endpoint.Endpoint + adapter.CatalogPath,
		}
		models, err := probeRuntimeCatalogAuthenticated(ctx, adapter, candidate, endpoint.BearerToken, client)
		if err != nil {
			document.Diagnostics = append(document.Diagnostics, detectedRuntimeDiagnostic{AdapterID: adapter.ID, Status: "unavailable", Code: "catalog_probe_failed"})
			continue
		}
		document.Runtimes = append(document.Runtimes, detectedRuntime{AdapterID: adapter.ID, Models: models})
		document.Diagnostics = append(document.Diagnostics, detectedRuntimeDiagnostic{AdapterID: adapter.ID, Status: "available", Code: "catalog_ok"})
	}
	sort.Slice(document.Runtimes, func(left, right int) bool { return document.Runtimes[left].AdapterID < document.Runtimes[right].AdapterID })
	sort.Slice(document.Diagnostics, func(left, right int) bool { return document.Diagnostics[left].AdapterID < document.Diagnostics[right].AdapterID })
	return document
}

func probeRuntimeCatalog(ctx context.Context, adapter runtimeAdapter, candidate adapterCandidate, client *http.Client) ([]string, error) {
	return probeRuntimeCatalogAuthenticated(ctx, adapter, candidate, "", client)
}

func probeRuntimeCatalogAuthenticated(ctx context.Context, adapter runtimeAdapter, candidate adapterCandidate, bearerToken string, client *http.Client) ([]string, error) {
	if err := validateLoopbackCandidate(adapter, candidate); err != nil {
		if len(adapter.Candidates) != 0 {
			return nil, err
		}
		configured, configuredErr := normalizeRuntimeEndpoints([]runtimeEndpoint{{
			AdapterID: adapter.ID, Endpoint: candidate.Endpoint, BearerToken: bearerToken,
		}}, runtimeAdapterRegistry())
		if configuredErr != nil || len(configured) != 1 ||
			candidate.HealthURL != configured[0].Endpoint+adapter.HealthPath ||
			candidate.CatalogURL != configured[0].Endpoint+adapter.CatalogPath {
			return nil, errors.New("provider runtime manual probe is invalid")
		}
	}
	if client == nil {
		return nil, errors.New("provider runtime probe requires an HTTP client")
	}
	probeContext, cancel := context.WithTimeout(ctx, time.Duration(adapter.Limits.TimeoutMS)*time.Millisecond)
	defer cancel()
	request, err := http.NewRequestWithContext(probeContext, http.MethodGet, candidate.CatalogURL, nil)
	if err != nil {
		return nil, errors.New("provider runtime catalog request is invalid")
	}
	request.Header.Set("accept", "application/json")
	if bearerToken != "" {
		request.Header.Set("authorization", "Bearer "+bearerToken)
	}
	probeClient := *client
	probeClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	response, err := probeClient.Do(request)
	if err != nil {
		return nil, errors.New("provider runtime catalog is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("provider runtime catalog returned a non-success status")
	}
	if response.ContentLength > int64(adapter.Limits.MaxResponseBytes) {
		return nil, errors.New("provider runtime catalog response is too large")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, int64(adapter.Limits.MaxResponseBytes)+1))
	if err != nil || len(body) > adapter.Limits.MaxResponseBytes {
		return nil, errors.New("provider runtime catalog response is too large")
	}
	var payload modelCatalogPayload
	if err := json.Unmarshal(body, &payload); err != nil || len(payload.Data) == 0 || len(payload.Data) > adapter.Limits.MaxCatalogModels {
		return nil, errors.New("provider runtime catalog payload is invalid")
	}
	expectedOwner := automaticRuntimeOwner(adapter.ID)
	models := make([]string, 0, len(payload.Data))
	seen := make(map[string]struct{}, len(payload.Data))
	for _, entry := range payload.Data {
		if expectedOwner != "" && entry.OwnedBy != expectedOwner {
			return nil, errors.New("provider runtime catalog has an invalid runtime signature")
		}
		if !validSelectedModelID(entry.ID) {
			return nil, errors.New("provider runtime catalog contains an invalid model id")
		}
		if _, exists := seen[entry.ID]; exists {
			continue
		}
		seen[entry.ID] = struct{}{}
		models = append(models, entry.ID)
	}
	sort.Strings(models)
	return models, nil
}
