package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const modelCompatibilityVersion = "provider-model-compatibility-v1"

type modelCompatibilityMemory struct {
	Device     string `json:"device"`
	ModelMiB   uint64 `json:"model_mib"`
	ContextMiB uint64 `json:"context_mib"`
	ComputeMiB uint64 `json:"compute_mib"`
}
type modelCompatibilityEstimate struct {
	ModelID        string                     `json:"model_id"`
	Aliases        []string                   `json:"aliases"`
	Variant        string                     `json:"variant"`
	State          string                     `json:"state"`
	Reason         string                     `json:"reason"`
	Runtime        string                     `json:"runtime,omitempty"`
	RuntimeVersion string                     `json:"runtime_version,omitempty"`
	Memory         []modelCompatibilityMemory `json:"memory,omitempty"`
	HostBudgetMiB  uint64                     `json:"host_budget_mib,omitempty"`
	BudgetMiB      uint64                     `json:"budget_mib,omitempty"`
}
type modelCompatibilityReport struct {
	SchemaVersion string                       `json:"schema_version"`
	ContextTokens uint64                       `json:"context_tokens"`
	CheckedAt     string                       `json:"checked_at"`
	Models        []modelCompatibilityEstimate `json:"models"`
}

func validCompatibilityContext(contextTokens uint64) bool {
	return contextTokens >= 512 && contextTokens <= 131072
}

// The estimation subprocess never starts a server or decodes tokens. Upstream
// common_get_device_memory_data_impl uses no_alloc=true and LOAD_MODE_NONE.
// Estimates refer to an exact catalog artifact, never a model-name heuristic.
func (engines *managedInferenceEngines) compatibility(ctx context.Context, contextTokens uint64) modelCompatibilityReport {
	report := modelCompatibilityReport{SchemaVersion: modelCompatibilityVersion, ContextTokens: contextTokens, CheckedAt: time.Now().UTC().Format(time.RFC3339), Models: []modelCompatibilityEstimate{}}
	if !validCompatibilityContext(contextTokens) {
		return report
	}
	for _, entry := range engines.backend.catalog.Models {
		report.Models = append(report.Models, modelCompatibilityEstimate{ModelID: entry.CanonicalModelID,
			Aliases: []string{entry.CanonicalModelID, strings.TrimPrefix(entry.CanonicalModelID, "hf:"), entry.OllamaModel},
			Variant: entry.OllamaModel, State: "unknown", Reason: "estimator_unavailable"})
	}
	// Share the lifecycle gate to avoid overlapping estimation, installation,
	// model loading or shutdown. This path never stops an active model.
	select {
	case engines.gate <- struct{}{}:
	case <-ctx.Done():
		return report
	}
	defer func() { <-engines.gate }()
	policy := engines.policies.snapshot()
	if policy == nil {
		return compatibilityReason(report, "storage_not_configured")
	}
	var release managedEngineRelease
	for _, candidate := range engines.releases {
		if candidate.ID == "llama-cpp" {
			release = candidate
			break
		}
	}
	if release.ID == "" {
		return report
	}
	root := filepath.Join(engines.manager.root, "engines", release.ID+"-"+managedEnginePin(release))
	executable, err := verifyManagedEngineInstallation(root, release)
	if err != nil {
		// A POST may install the pinned diagnostic tool under existing download
		// consent. It never downloads a model or starts an inference process.
		if _, statErr := os.Lstat(root); !errors.Is(statErr, os.ErrNotExist) {
			return report
		}
		if err = engines.currentPolicy(policy, true); err != nil {
			return report
		}
		installCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
		executable, err = engines.install(installCtx, policy, release)
		cancel()
		if err != nil {
			return report
		}
	}
	tool := filepath.Join(filepath.Dir(executable), "llama-fit-params")
	if engines.manager.goos == "windows" {
		tool += ".exe"
	}
	info, err := os.Lstat(tool)
	if err != nil || !info.Mode().IsRegular() {
		return report
	}
	// The companion executable and libraries were attested above.
	if engines.manager.goos != "windows" && info.Mode().Perm()&0100 == 0 {
		return report
	}
	environment := engines.manager.commandEnvironment(policy.Policy.ModelStoragePath)
	device := "none"
	if release.Backend == "metal" {
		device = "Metal"
	}
	if release.Backend == "cuda" {
		device = "CUDA0"
	}
	if release.Backend == "vulkan" {
		probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		output, probeErr := engines.manager.commands.Run(probeCtx, executable, []string{"--list-devices"}, environment, filepath.Dir(executable), 64*1024)
		cancel()
		var deviceErr error
		device, deviceErr = managedVulkanDevice(output, engines.backend.localCapability)
		if probeErr != nil || deviceErr != nil {
			return compatibilityReason(report, "device_unavailable")
		}
	}
	budget := engines.backend.localCapability.AcceleratorMemoryBytes / (1 << 20)
	if policy.Policy.GPUVRAMPercent != nil {
		budget = budget * uint64(*policy.Policy.GPUVRAMPercent) / 100
	}
	hostBudget := compatibilityHostMemory(engines.backend.localCapability)
	for index, entry := range engines.backend.catalog.Models {
		result := &report.Models[index]
		result.Runtime = "llama.cpp"
		result.RuntimeVersion = release.Version
		result.BudgetMiB = budget
		result.HostBudgetMiB = hostBudget
		path, pathErr := engines.compatibilityGGUF(policy.Policy.ModelStoragePath, entry)
		if pathErr != nil {
			result.Reason = "model_metadata_unavailable"
			continue
		}
		layers := "0"
		if device != "none" {
			layers = "999"
		}
		args := []string{"--model", path, "--ctx-size", strconv.FormatUint(contextTokens, 10), "--batch-size", "128", "--ubatch-size", "128",
			"--parallel", "1", "--device", device, "--n-gpu-layers", layers, "--fit-print", "on", "--offline", "--log-disable"}
		probeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		output, probeErr := engines.manager.commands.Run(probeCtx, tool, args, environment, filepath.Dir(tool), 64*1024)
		cancel()
		if probeErr != nil {
			result.Reason = "runtime_estimate_unavailable"
			continue
		}
		memory, parseErr := parseRuntimeMemory(output)
		if parseErr != nil {
			result.Reason = "runtime_estimate_unavailable"
			continue
		}
		result.Memory = memory
		result.State, result.Reason = classifyRuntimeMemory(memory, engines.backend.localCapability, device, budget, hostBudget)
	}
	return report
}

func compatibilityReason(report modelCompatibilityReport, reason string) modelCompatibilityReport {
	for index := range report.Models {
		report.Models[index].Reason = reason
	}
	return report
}

func (engines *managedInferenceEngines) compatibilityGGUF(storage string, entry providerModelCatalogEntry) (string, error) {
	if _, err := engines.manager.verifyCatalogModel(storage, entry); err != nil {
		return "", err
	}
	raw, digest, err := readManagedOllamaStableRegularFile(filepath.Join(storage, "manifests", filepath.FromSlash(entry.OllamaManifestPath)), managedOllamaModelManifestMaxBytes)
	if err != nil || "sha256:"+digest != entry.ContentDigest {
		return "", errRuntimeBackendIncompatible
	}
	var manifest managedOllamaModelManifest
	if json.Unmarshal(raw, &manifest) != nil {
		return "", errRuntimeBackendIncompatible
	}
	path := ""
	for _, layer := range manifest.Layers {
		if layer.MediaType != "application/vnd.ollama.image.model" {
			continue
		}
		if path != "" {
			return "", errRuntimeBackendIncompatible
		}
		path = filepath.Join(storage, "blobs", strings.ReplaceAll(layer.Digest, ":", "-"))
	}
	if path == "" {
		return "", errRuntimeBackendIncompatible
	}
	return path, nil
}

func parseRuntimeMemory(output []byte) ([]modelCompatibilityMemory, error) {
	var result []modelCompatibilityMemory
	seen := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 4 || seen[fields[0]] || len(seen) >= 8 {
			return nil, errRuntimeBackendInvalid
		}
		name := fields[0]
		if name != "Host" && name != "Metal" && name != "CUDA0" && name != "Vulkan0" {
			return nil, errRuntimeBackendInvalid
		}
		values := [3]uint64{}
		for index, field := range fields[1:] {
			n, err := strconv.ParseUint(field, 10, 64)
			if err != nil || n > 1<<30 || strconv.FormatUint(n, 10) != field {
				return nil, errRuntimeBackendInvalid
			}
			values[index] = n
		}
		seen[name] = true
		result = append(result, modelCompatibilityMemory{Device: name, ModelMiB: values[0], ContextMiB: values[1], ComputeMiB: values[2]})
	}
	if !seen["Host"] {
		return nil, errRuntimeBackendInvalid
	}
	return result, nil
}

// Only add the runtime's reported components and compare to a known budget.
// There is no parameter-count, file-size, KV-cache or quantization formula.
func classifyRuntimeMemory(memory []modelCompatibilityMemory, host hostCapability, device string, budget, hostBudget uint64) (string, string) {
	var hostMiB, deviceMiB uint64
	foundDevice := false
	for _, row := range memory {
		total := row.ModelMiB + row.ContextMiB + row.ComputeMiB
		if row.Device == "Host" {
			hostMiB = total
		} else if row.Device == device {
			deviceMiB += total
			foundDevice = true
		} else {
			return "unknown", "device_unavailable"
		}
	}
	if budget == 0 || hostMiB+deviceMiB == 0 {
		return "unknown", "memory_budget_unavailable"
	}
	if device == "none" {
		if deviceMiB != 0 {
			return "unknown", "device_unavailable"
		}
		if hostMiB >= budget {
			return "insufficient", "memory_budget_exceeded"
		}
		return "compatible", "runtime_memory_estimate"
	}
	if !foundDevice {
		return "unknown", "device_unavailable"
	}
	if host.Accelerator == "metal" {
		// CPU and Metal allocations share the same physical memory pool.
		if hostMiB+deviceMiB >= budget {
			return "insufficient", "memory_budget_exceeded"
		}
		return "compatible", "runtime_memory_estimate"
	}
	if deviceMiB >= budget {
		return "insufficient", "memory_budget_exceeded"
	}
	// Discrete GPUs also require a separately measured host RAM budget.
	if hostMiB > 0 && hostBudget == 0 {
		return "unknown", "host_memory_budget_unavailable"
	}
	if hostMiB > 0 && hostMiB >= hostBudget {
		return "insufficient", "host_memory_budget_exceeded"
	}
	return "compatible", "runtime_memory_estimate"
}

func modelCompatibilityHandler(controller *managedProviderController, controlToken string) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if !authorizeProviderControl(request, controlToken) {
			http.Error(response, "not found", 404)
			return
		}
		response.Header().Set("cache-control", "no-store")
		if request.Header.Get("content-type") != "application/json" {
			http.Error(response, "invalid request", 415)
			return
		}
		request.Body = http.MaxBytesReader(response, request.Body, 1024)
		raw := new(bytes.Buffer)
		if _, err := raw.ReadFrom(request.Body); err != nil || validateUniqueJSONKeys(raw.Bytes()) != nil {
			http.Error(response, "invalid request", 400)
			return
		}
		var input struct {
			ContextTokens uint64 `json:"context_tokens"`
		}
		decoder := json.NewDecoder(bytes.NewReader(raw.Bytes()))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || ensureJSONEOF(decoder) != nil || !validCompatibilityContext(input.ContextTokens) {
			http.Error(response, "invalid request", 400)
			return
		}
		if controller == nil {
			http.Error(response, "estimator unavailable", 503)
			return
		}
		backend, ok := controller.runtime.(*ollamaRuntimeBackend)
		if !ok || backend.engines == nil {
			http.Error(response, "estimator unavailable", 503)
			return
		}
		ctx, cancel := context.WithTimeout(request.Context(), 2*time.Minute)
		defer cancel()
		report := backend.engines.compatibility(ctx, input.ContextTokens)
		response.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(response).Encode(report)
	}
}
