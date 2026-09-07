package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/thibautrey/multivibe/provider-agent/runtimeprofile"
)

// Capture the reviewed catalog once, alongside the pinned model/runtime
// catalogs. Hardware identity comes from local discovery, never a Cloud claim.
func (backend *ollamaRuntimeBackend) configureReviewedProfiles(path string, capability hostCapability) error {
	catalog, err := runtimeprofile.Load(path, runtimeprofile.MigrationDefaults{})
	if err != nil {
		return err
	}
	backend.reviewedProfiles = &catalog
	backend.localCapability = capability
	backend.loadedProfiles = make(map[string]runtimeprofile.Profile)
	return nil
}

func (backend *ollamaRuntimeBackend) bindReviewedProfile(modelID string, policy *capacityPolicyStateDocument, contextTokens uint64) error {
	if backend.reviewedProfiles == nil {
		return nil
	}
	if policy == nil || policy.Policy.GPUVRAMPercent == nil {
		return errRuntimeBackendIncompatible
	}
	host := backend.localCapability
	available := host.AcceleratorMemoryBytes / 100 * uint64(*policy.Policy.GPUVRAMPercent)
	artifact := backend.descriptor.Launch.Provenance.ArtifactSHA256[host.OS+"-"+host.Architecture]
	for _, entry := range backend.catalog.Models {
		if entry.CanonicalModelID != modelID {
			continue
		}
		for _, profile := range backend.reviewedProfiles.Profiles {
			if profile.Model.ID != modelID || profile.Model.ContentDigest != entry.ContentDigest ||
				profile.Model.LicenseAssessment != "sha256:"+strings.TrimPrefix(entry.License.AssessmentDigest, "sha256:") || profile.Model.ArtifactBytes != entry.DownloadBytes ||
				profile.Hardware.OS != host.OS || profile.Hardware.Architecture != host.Architecture ||
				profile.Hardware.AcceleratorKind != host.Accelerator || host.AcceleratorMemoryBytes < profile.Hardware.MinimumAcceleratorMemoryBytes ||
				profile.Runtime.AdapterVersion != "ollama-adapter-v1" || profile.Tuning.Parallelism != 1 {
				continue
			}
			selection, err := runtimeprofile.Select(*backend.reviewedProfiles, runtimeprofile.SelectionRequest{
				ModelID: modelID, ContentDigest: entry.ContentDigest, Format: profile.Model.Format, Quantization: profile.Model.Quantization,
				RequiredContextTokens: contextTokens, Hardware: profile.Hardware, AvailableMemoryBytes: available,
				Runtimes: []runtimeprofile.RuntimeCapability{{BackendID: backend.descriptor.ID, ContractVersion: runtimeBackendContractVersion,
					Available: true, Formats: []string{profile.Model.Format}, Quantizations: []string{profile.Model.Quantization},
					HardwareClasses: []string{profile.Hardware.Class}, MaximumContextTokens: backend.descriptor.Launch.Resources.MaximumContextTokens,
					MaximumBatchSize: 4096, MaximumParallelism: 1, MaximumMemoryBytes: available, SupportsGPUOffload: true,
					RuntimeArtifactDigest: "sha256:" + strings.TrimPrefix(artifact, "sha256:")}},
			})
			if err != nil {
				continue
			}
			backend.mu.Lock()
			backend.loadedProfiles[modelID] = selection.Effective.Profile
			backend.mu.Unlock()
			return nil
		}
	}
	return errRuntimeBackendIncompatible
}

func reviewedAlias(profile runtimeprofile.Profile) string {
	return "multivibe-reviewed:" + strings.TrimPrefix(profile.ProfileDigest, "sha256:")
}

// Ollama's OpenAI endpoint does not accept num_ctx/num_batch/num_gpu.
// Apply these as model parameters via the native create API; retain the
// original verified model and its manifest without modifying either.
func (backend *ollamaRuntimeBackend) prepareReviewedAlias(ctx context.Context, modelID, source string) (string, error) {
	backend.mu.Lock()
	profile, ok := backend.loadedProfiles[modelID]
	backend.mu.Unlock()
	if !ok {
		return "", errRuntimeBackendIncompatible
	}
	alias := reviewedAlias(profile)
	err := backend.reviewedModelRequest(ctx, "/api/create", map[string]any{
		"model": alias, "from": source, "stream": false,
		"parameters": map[string]any{"num_ctx": profile.Tuning.ContextTokens, "num_batch": profile.Tuning.BatchSize, "num_gpu": profile.Tuning.GPUOffloadLayers},
	})
	return alias, err
}

func (backend *ollamaRuntimeBackend) reviewedModelRequest(ctx context.Context, path string, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return errRuntimeBackendInvalid
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, backend.endpoint+path, bytes.NewReader(body))
	if err != nil {
		return errRuntimeBackendInvalid
	}
	request.Header.Set("content-type", "application/json")
	response, err := backend.client.Do(request)
	if err != nil {
		return normalizeOllamaExecutionError(ctx, 0, nil, err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4097))
	if err != nil || len(raw) > 4096 {
		return errRuntimeBackendCrashed
	}
	if response.StatusCode != http.StatusOK {
		return normalizeOllamaExecutionError(ctx, response.StatusCode, raw, nil)
	}
	var result struct {
		Error  string `json:"error"`
		Status string `json:"status"`
		Done   bool   `json:"done"`
	}
	if json.Unmarshal(raw, &result) != nil || result.Error != "" || (path == "/api/create" && result.Status != "success") {
		return errRuntimeBackendCrashed
	}
	return nil
}

func (backend *ollamaRuntimeBackend) unloadReviewedAlias(ctx context.Context, modelID string) error {
	if backend.reviewedProfiles == nil {
		return nil
	}
	backend.mu.Lock()
	profile, ok := backend.loadedProfiles[modelID]
	backend.mu.Unlock()
	if !ok {
		return nil
	}
	return backend.reviewedModelRequest(ctx, "/api/generate", map[string]any{"model": reviewedAlias(profile), "keep_alive": 0, "stream": false})
}

func reviewedOllamaExecutionBody(input []byte, model string, stream bool) ([]byte, error) {
	// Prevent request-level resource options from bypassing reviewed defaults.
	var payload map[string]json.RawMessage
	if validateUniqueJSONKeys(input) != nil || json.Unmarshal(input, &payload) != nil {
		return nil, errRuntimeBackendInvalid
	}
	for _, key := range []string{"options", "num_ctx", "num_batch", "num_gpu", "num_parallel", "keep_alive"} {
		if _, exists := payload[key]; exists {
			return nil, errRuntimeBackendInvalid
		}
	}
	return ollamaExecutionBody(input, model, stream)
}
