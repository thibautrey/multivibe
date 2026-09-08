package main

import (
	"bytes"
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/thibautrey/multivibe/provider-agent/runtimeprofile"
)

// Model provenance remains the pinned Ollama registry manifest. The execution
// engine is selected locally from compiled releases and reviewed GGUF profiles.
// No endpoint discovered on the LAN or supplied by a request participates.
//
//go:embed managed_engine_profiles.json
var managedEngineProfiles []byte

type managedInferenceEngines struct {
	profiles       runtimeprofile.Catalog
	manager        *managedOllama
	backend        *ollamaRuntimeBackend
	policies       *capacityPolicyStore
	releases       []managedEngineRelease
	downloadClient *http.Client
	client         *http.Client
	gate           chan struct{}
	mu             sync.Mutex
	cancel         context.CancelFunc
	ready          bool
	process        managedOllamaProcess
	done           chan error
	modelID        string
	profileDigest  string
	policyRevision uint64
	endpoint       string
	key            string
	selected       string
	version        string
	fallback       string
	failed         map[string]bool
}

func newManagedInferenceEngines(backend *ollamaRuntimeBackend, manager *managedOllama, policies *capacityPolicyStore) (*managedInferenceEngines, error) {
	if backend == nil || manager == nil || policies == nil || backend.reviewedProfiles == nil {
		return nil, errRuntimeBackendInvalid
	}
	var profiles runtimeprofile.Catalog
	if json.Unmarshal(managedEngineProfiles, &profiles) != nil || runtimeprofile.Validate(profiles) != nil {
		return nil, errRuntimeBackendInvalid
	}
	releases, err := managedEngineReleases(backend.localCapability)
	if err != nil {
		return nil, err
	}
	return &managedInferenceEngines{backend: backend, manager: manager, policies: policies, releases: releases, profiles: profiles,
		downloadClient: managedEngineHTTPClient(), client: &http.Client{Timeout: 5 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		gate: make(chan struct{}, 1), selected: "ollama", version: managedOllamaVersion, failed: map[string]bool{}}, nil
}

func (engines *managedInferenceEngines) profile(release managedEngineRelease, modelID string, policy *capacityPolicyStateDocument) (runtimeprofile.Profile, error) {
	host := engines.backend.localCapability
	if policy == nil || policy.Policy.GPUVRAMPercent == nil {
		return runtimeprofile.Profile{}, errRuntimeBackendIncompatible
	}
	entry, ok := engines.backend.catalog.entry(modelID)
	if !ok {
		return runtimeprofile.Profile{}, errRuntimeBackendIncompatible
	}
	engines.backend.mu.Lock()
	base, ok := engines.backend.loadedProfiles[modelID]
	engines.backend.mu.Unlock()
	if !ok {
		return runtimeprofile.Profile{}, errRuntimeBackendIncompatible
	}
	for _, profile := range engines.profiles.Profiles {
		if profile.Runtime.BackendID != release.ID+"-managed" || profile.Runtime.AdapterVersion != release.ID+"-adapter-v1" ||
			profile.Runtime.RuntimeArtifactDigest != "sha256:"+release.Artifacts[0].SHA256 || profile.Model.ID != modelID ||
			profile.Model.ContentDigest != entry.ContentDigest || profile.Model.ArtifactBytes != entry.DownloadBytes ||
			profile.Model.LicenseAssessment != "sha256:"+strings.TrimPrefix(entry.License.AssessmentDigest, "sha256:") ||
			profile.Hardware.OS != host.OS || profile.Hardware.Architecture != host.Architecture || profile.Hardware.AcceleratorKind != host.Accelerator ||
			profile.Model.Format != "gguf" || profile.Tuning.Parallelism != 1 || profile.Tuning.ContextTokens != base.Tuning.ContextTokens {
			continue
		}
		memory := host.AcceleratorMemoryBytes / 100 * uint64(*policy.Policy.GPUVRAMPercent)
		selected, err := runtimeprofile.Select(engines.profiles, runtimeprofile.SelectionRequest{
			ModelID: modelID, ContentDigest: entry.ContentDigest, Format: profile.Model.Format, Quantization: profile.Model.Quantization,
			RequiredContextTokens: base.Tuning.ContextTokens, Hardware: profile.Hardware, AvailableMemoryBytes: host.AcceleratorMemoryBytes,
			Runtimes: []runtimeprofile.RuntimeCapability{{BackendID: release.ID + "-managed", ContractVersion: runtimeBackendContractVersion, Available: true,
				Formats: []string{profile.Model.Format}, Quantizations: []string{profile.Model.Quantization}, HardwareClasses: []string{profile.Hardware.Class},
				MaximumContextTokens: base.Tuning.ContextTokens, MaximumBatchSize: 4096, MaximumParallelism: 1, MaximumMemoryBytes: memory,
				SupportsGPUOffload: host.Accelerator != "cpu", RuntimeArtifactDigest: profile.Runtime.RuntimeArtifactDigest}},
		})
		if err == nil {
			return selected.Effective.Profile, nil
		}
	}
	return runtimeprofile.Profile{}, errRuntimeBackendIncompatible
}

func (engines *managedInferenceEngines) currentPolicy(expected *capacityPolicyStateDocument, download bool) error {
	current := engines.policies.snapshot()
	if current == nil || expected == nil || current.Revision != expected.Revision {
		return errManagedControllerSuperseded
	}
	_, err := engines.manager.authorizePolicy(current, download)
	return err
}

// prepare may fall back only before a prompt has been sent. Runtime or stream
// errors after dispatch are returned, never replayed against another engine.
func (engines *managedInferenceEngines) prepare(ctx context.Context, policy *capacityPolicyStateDocument, modelID string) error {
	select {
	case engines.gate <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-engines.gate }()
	ctx, cancel := context.WithCancel(ctx)
	engines.mu.Lock()
	engines.cancel = cancel
	engines.mu.Unlock()
	defer func() { cancel(); engines.mu.Lock(); engines.cancel = nil; engines.mu.Unlock() }()
	if err := engines.currentPolicy(policy, false); err != nil {
		return err
	}
	engines.mu.Lock()
	already := engines.ready && engines.process != nil && engines.modelID == modelID && engines.policyRevision == policy.Revision
	done := engines.done
	profileDigest := engines.profileDigest
	selectedID := engines.selected
	engines.policyRevision = policy.Revision
	engines.mu.Unlock()
	if already {
		select {
		case <-done:
			already = false
		default:
		}
	}
	if already {
		matches := false
		for _, release := range engines.releases {
			if release.ID != selectedID {
				continue
			}
			profile, err := engines.profile(release, modelID, policy)
			if err == nil && profile.ProfileDigest == profileDigest {
				matches = true
			}
		}
		if matches {
			return nil
		}
	}
	if err := engines.stopProcess(ctx); err != nil {
		return err
	}
	for _, release := range engines.releases {
		profile, err := engines.profile(release, modelID, policy)
		if err != nil {
			continue
		}
		failureKey := managedEnginePin(release) + "/" + profile.ProfileDigest
		engines.mu.Lock()
		failed := engines.failed[failureKey]
		engines.mu.Unlock()
		if failed {
			continue
		}
		executable, err := engines.install(ctx, policy, release)
		if err == nil {
			var weights string
			weights, err = engines.gguf(policy, modelID)
			if err == nil {
				err = engines.launch(ctx, policy, release, profile, executable, weights)
			}
		}
		if err == nil {
			return nil
		}
		if stopErr := engines.stopProcess(context.Background()); stopErr != nil {
			return stopErr
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if policyErr := engines.currentPolicy(policy, false); policyErr != nil {
			return policyErr
		}
		engines.mu.Lock()
		// Disabling downloads is reversible without restarting the agent.
		if !errors.Is(err, errManagedOllamaDownloadsDisabled) {
			engines.failed[failureKey] = true
		}
		engines.fallback = "optimized_runtime_unavailable"
		engines.mu.Unlock()
	}
	if err := engines.currentPolicy(policy, false); err != nil {
		return err
	}
	if _, err := engines.manager.start(ctx, policy); err != nil {
		return err
	}
	engines.mu.Lock()
	engines.selected = "ollama"
	engines.version = managedOllamaVersion
	engines.mu.Unlock()
	return nil
}

func (engines *managedInferenceEngines) gguf(policy *capacityPolicyStateDocument, modelID string) (string, error) {
	// Verify the inventory, exact manifest and every blob before exposing a path.
	if _, err := engines.manager.authorizeModelActivationPinned(policy, engines.backend.catalog, modelID); err != nil {
		return "", err
	}
	entry, _ := engines.backend.catalog.entry(modelID)
	storage := policy.Policy.ModelStoragePath
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
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	var magic [4]byte
	if _, err = io.ReadFull(file, magic[:]); err != nil || string(magic[:]) != "GGUF" {
		return "", errRuntimeBackendIncompatible
	}
	return path, nil
}

func (engines *managedInferenceEngines) launch(ctx context.Context, policy *capacityPolicyStateDocument, release managedEngineRelease, profile runtimeprofile.Profile, executable, weights string) error {
	if err := engines.currentPolicy(policy, false); err != nil {
		return err
	}
	// Release Ollama's resident model before allocating another engine's cache.
	if err := engines.manager.stop(ctx); err != nil {
		return err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	keyBytes := make([]byte, 32)
	if _, err = rand.Read(keyBytes); err != nil {
		return err
	}
	key := hex.EncodeToString(keyBytes)
	arguments := managedEngineArguments(release, profile, weights, port)
	if policy.Policy.GPUUtilizationPercent != nil {
		threads := max(1, runtime.NumCPU()*int(*policy.Policy.GPUUtilizationPercent)/100)
		for i := 0; i < len(arguments)-1; i++ {
			if arguments[i] == "--threads" {
				arguments[i+1] = strconv.Itoa(threads)
			}
		}
	}
	environment := engines.manager.commandEnvironment(policy.Policy.ModelStoragePath)
	environment = append(environment, "LLAMA_API_KEY="+key)
	if release.Backend == "vulkan" {
		// Probe a pinned binary, not a user-installed executable. Require exactly
		// one Vulkan device matching the selected NVIDIA model; otherwise fall back.
		probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		output, probeErr := engines.manager.commands.Run(probeCtx, executable, []string{"--list-devices"}, environment, filepath.Dir(executable), 64*1024)
		cancel()
		device, probeErr2 := managedVulkanDevice(output, engines.backend.localCapability)
		if probeErr != nil || probeErr2 != nil {
			return errRuntimeBackendIncompatible
		}
		arguments = append(arguments, "--device", device)
	}
	if release.ID == "llamafile" {
		// APE binaries require the upstream shell trampoline on Linux systems
		// without binfmt_misc. This fixed argv never evaluates request text.
		arguments = append([]string{executable, "--server"}, arguments...)
		executable = "/bin/sh"
	}
	if _, err = engines.manager.lockAuthorizedPolicy(policy, false); err != nil {
		return err
	}
	process, err := engines.manager.commands.Start(executable, arguments, environment, engines.manager.root, io.Discard, io.Discard)
	engines.manager.mu.Unlock()
	if err != nil {
		return errors.New("managed engine failed to start")
	}
	done := make(chan error, 1)
	engines.mu.Lock()
	engines.process = process
	engines.done = done
	engines.modelID = profile.Model.ID
	engines.profileDigest = profile.ProfileDigest
	engines.policyRevision = policy.Revision
	engines.endpoint = fmt.Sprintf("http://127.0.0.1:%d", port)
	engines.key = key
	engines.selected = release.ID
	engines.version = release.Version
	engines.mu.Unlock()
	go func() { done <- process.Wait(); close(done) }()
	readyCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if err = engines.waitReady(readyCtx, done); err != nil {
		return err
	}
	if err = engines.currentPolicy(policy, false); err != nil {
		return err
	}
	engines.mu.Lock()
	engines.fallback = ""
	engines.ready = true
	engines.mu.Unlock()
	return nil
}

func managedEngineArguments(release managedEngineRelease, profile runtimeprofile.Profile, weights string, port int) []string {
	tuning := profile.Tuning
	return []string{"--model", weights, "--alias", profile.Model.ID, "--host", "127.0.0.1", "--port", strconv.Itoa(port),
		"--ctx-size", strconv.FormatUint(tuning.ContextTokens, 10), "--batch-size", strconv.FormatUint(uint64(tuning.BatchSize), 10),
		"--ubatch-size", strconv.FormatUint(uint64(tuning.BatchSize), 10), "--parallel", "1", "--n-gpu-layers", strconv.FormatUint(uint64(tuning.GPUOffloadLayers), 10),
		"--threads", strconv.Itoa(runtime.NumCPU()), "--fit", "off", "--cache-ram", "0", "--offline", "--no-webui", "--no-slots", "--no-context-shift", "--log-disable"}
}

func managedVulkanDevice(output []byte, host hostCapability) (string, error) {
	if len(host.GPUs) != 1 || host.CUDADevice != 0 {
		return "", errRuntimeBackendIncompatible
	}
	device := ""
	count := 0
	for _, line := range strings.Split(string(output), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "Vulkan") {
			continue
		}
		count++
		parts := strings.SplitN(line, ": ", 2)
		if len(parts) != 2 || parts[0] != "Vulkan0" || !strings.HasPrefix(parts[1], host.GPUs[0].Name+" (") {
			continue
		}
		device = parts[0]
	}
	if count != 1 || device == "" {
		return "", errRuntimeBackendIncompatible
	}
	return device, nil
}

func (engines *managedInferenceEngines) waitReady(ctx context.Context, done <-chan error) error {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		engines.mu.Lock()
		endpoint, key, model := engines.endpoint, engines.key, engines.modelID
		engines.mu.Unlock()
		request, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"/v1/models", nil)
		request.Header.Set("Authorization", "Bearer "+key)
		response, err := engines.client.Do(request)
		if err == nil {
			raw, readErr := io.ReadAll(io.LimitReader(response.Body, 64*1024))
			response.Body.Close()
			var catalog struct {
				Data []struct {
					ID string `json:"id"`
				} `json:"data"`
			}
			if response.StatusCode == http.StatusOK && readErr == nil && json.Unmarshal(raw, &catalog) == nil && len(catalog.Data) == 1 && catalog.Data[0].ID == model {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-done:
			return errors.New("managed engine exited before readiness")
		case <-ticker.C:
		}
	}
}

func (engines *managedInferenceEngines) stopProcess(ctx context.Context) error {
	engines.mu.Lock()
	process, done := engines.process, engines.done
	engines.mu.Unlock()
	if process == nil {
		return nil
	}
	if err := requestManagedOllamaStop(process); err != nil && !errors.Is(err, os.ErrProcessDone) {
		_ = process.Kill()
	}
	if !managedOllamaWait(ctx, done, engines.manager.shutdownTimeout) {
		if err := process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			return err
		}
		if !managedOllamaWait(context.Background(), done, engines.manager.killTimeout) {
			return errors.New("managed engine did not stop")
		}
	}
	engines.mu.Lock()
	engines.ready = false
	engines.process = nil
	engines.done = nil
	engines.modelID = ""
	engines.endpoint = ""
	engines.key = ""
	engines.selected = "ollama"
	engines.version = managedOllamaVersion
	engines.mu.Unlock()
	return nil
}

func (engines *managedInferenceEngines) stop(ctx context.Context) error {
	engines.mu.Lock()
	cancel := engines.cancel
	engines.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	select {
	case engines.gate <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-engines.gate }()
	return engines.stopProcess(ctx)
}

func (engines *managedInferenceEngines) enforcePolicy(ctx context.Context, policy *capacityPolicyStateDocument) error {
	engines.mu.Lock()
	revision := engines.policyRevision
	cancel := engines.cancel
	engines.mu.Unlock()
	if policy == nil || policy.Paused == nil || *policy.Paused || policy.Revision != revision {
		if cancel != nil {
			cancel()
		}
		return engines.stop(ctx)
	}
	return nil
}

func (engines *managedInferenceEngines) target() (string, string, string) {
	engines.mu.Lock()
	defer engines.mu.Unlock()
	if engines.process == nil || !engines.ready {
		return "", "", ""
	}
	return engines.endpoint, engines.key, engines.modelID
}

func (engines *managedInferenceEngines) augmentStatus(status managedOllamaStatus) managedOllamaStatus {
	engines.mu.Lock()
	defer engines.mu.Unlock()
	status.ExecutionRuntime = engines.selected
	status.ExecutionVersion = engines.version
	status.FallbackReason = engines.fallback
	if engines.process != nil {
		select {
		case <-engines.done:
			status.Running = false
			status.State = "failed"
		default:
			status.Running = engines.ready
			status.State = "starting"
			if engines.ready {
				status.State = "running"
			}
		}
	}
	return status
}

func managedEngineExecutionBody(input []byte, model string, stream bool) ([]byte, error) {
	body, err := reviewedOllamaExecutionBody(input, model, stream)
	if err != nil {
		return nil, err
	}
	var payload map[string]json.RawMessage
	if json.Unmarshal(body, &payload) != nil {
		return nil, errRuntimeBackendInvalid
	}
	// Restrict to the OpenAI chat surface. Native extensions must not override
	// templates, load files/adapters, expand caches, or enable remote media fetches.
	allowed := map[string]bool{"model": true, "messages": true, "stream": true, "stream_options": true, "temperature": true, "top_p": true,
		"max_tokens": true, "max_completion_tokens": true, "stop": true, "seed": true, "frequency_penalty": true, "presence_penalty": true,
		"response_format": true, "tools": true, "tool_choice": true, "parallel_tool_calls": true, "logprobs": true, "top_logprobs": true, "n": true, "store": true}
	for key := range payload {
		if !allowed[key] {
			return nil, errRuntimeBackendInvalid
		}
	}
	if raw, ok := payload["n"]; ok {
		var n int
		if json.Unmarshal(raw, &n) != nil || n != 1 {
			return nil, errRuntimeBackendInvalid
		}
	}
	var messages []struct {
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(payload["messages"], &messages) != nil {
		return nil, errRuntimeBackendInvalid
	}
	for _, message := range messages {
		content := bytes.TrimSpace(message.Content)
		if len(content) > 0 && content[0] == '[' {
			var parts []struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(content, &parts) != nil {
				return nil, errRuntimeBackendInvalid
			}
			for _, part := range parts {
				if part.Type != "text" {
					return nil, errRuntimeBackendIncompatible
				}
			}
		}
	}
	return body, nil
}
