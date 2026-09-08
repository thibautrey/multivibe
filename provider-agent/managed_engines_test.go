package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/thibautrey/multivibe/provider-agent/runtimeprofile"
)

func testManagedEngines(t *testing.T) (*managedInferenceEngines, *capacityPolicyStateDocument) {
	t.Helper()
	manager := newManagedOllamaTestManager(t, managedOllamaConfig{GOOS: "linux", GOARCH: "amd64", CPUOnly: true, Commands: &managedOllamaTestCommands{}})
	if err := manager.ensureLayout(); err != nil {
		t.Fatal(err)
	}
	root, _ := filepath.Abs("../packaging")
	backend, err := newOllamaRuntimeBackend(manager, filepath.Join(root, "provider-model-catalog.json"), filepath.Join(root, "provider-host-dependencies.json"))
	if err != nil {
		t.Fatal(err)
	}
	host := hostCapability{Supported: true, Profile: "linux-cpu", OS: "linux", Architecture: "amd64", Accelerator: "cpu", AcceleratorMemoryBytes: 4 << 30}
	if err = backend.configureReviewedProfiles(filepath.Join(root, "provider-runtime-profiles.json"), host); err != nil {
		t.Fatal(err)
	}
	policies := newMemoryCapacityPolicyStore()
	state := managedOllamaTestPolicy(filepath.Join(manager.root, "models"), 0, false, true)
	policy, conflict, err := policies.replace(0, *state)
	if err != nil || conflict {
		t.Fatal(err)
	}
	engines, err := newManagedInferenceEngines(backend, manager, policies)
	if err != nil {
		t.Fatal(err)
	}
	backend.engines = engines
	if err = backend.bindReviewedProfile(workerTestCanonicalModel, policy, 1); err != nil {
		t.Fatal(err)
	}
	return engines, policy
}

func TestManagedEnginesHardwareAndReviewedProfiles(t *testing.T) {
	engines, policy := testManagedEngines(t)
	for _, release := range engines.releases {
		profile, err := engines.profile(release, workerTestCanonicalModel, policy)
		if err != nil || profile.Tuning.GPUOffloadLayers != 0 || profile.Tuning.ContextTokens != 2048 {
			t.Fatalf("CPU review mismatch: %s %v", release.ID, err)
		}
		changed := release
		changed.Artifacts = append([]managedEngineArtifact{}, release.Artifacts...)
		changed.Artifacts[0].SHA256 = strings.Repeat("f", 64)
		if _, err = engines.profile(changed, workerTestCanonicalModel, policy); err == nil {
			t.Fatal("unreviewed runtime pin accepted")
		}
	}
	for _, test := range []struct {
		host hostCapability
		want string
	}{
		{hostCapability{OS: "darwin", Architecture: "arm64", Accelerator: "metal"}, "llama-cpp"},
		{hostCapability{OS: "linux", Architecture: "arm64", Accelerator: "cpu"}, "llama-cpp"},
		{hostCapability{OS: "linux", Architecture: "amd64", Accelerator: "cpu"}, "llamafile,llama-cpp"},
		{hostCapability{OS: "windows", Architecture: "amd64", Accelerator: "cuda"}, "llama-cpp"},
		{hostCapability{OS: "linux", Architecture: "amd64", Accelerator: "cuda", GPUs: []nvidiaGPUCapability{{Name: "NVIDIA Test"}}}, "llama-cpp"},
		{hostCapability{OS: "linux", Architecture: "amd64", Accelerator: "cuda", GPUs: []nvidiaGPUCapability{{}, {}}}, ""},
		{hostCapability{OS: "freebsd", Architecture: "amd64", Accelerator: "cpu"}, ""},
	} {
		releases, err := managedEngineReleases(test.host)
		if err != nil {
			t.Fatal(err)
		}
		var ids []string
		for _, release := range releases {
			ids = append(ids, release.ID)
		}
		if strings.Join(ids, ",") != test.want {
			t.Fatalf("wrong hardware candidates: %v %v", test.host, ids)
		}
	}
	narrowed := cloneCapacityPolicyState(*policy)
	*narrowed.Policy.GPUVRAMPercent = 1
	if _, err := engines.profile(engines.releases[0], workerTestCanonicalModel, narrowed); err == nil {
		t.Fatal("memory budget bypassed")
	}
	host := hostCapability{GPUs: []nvidiaGPUCapability{{Name: "NVIDIA Test"}}}
	if _, err := managedVulkanDevice([]byte("Vulkan0: NVIDIA Test (8192 MiB)\n"), host); err != nil {
		t.Fatal(err)
	}
	for _, probe := range []string{"Vulkan0: Other GPU (8192 MiB)", "Vulkan0: NVIDIA Test (8192 MiB)\nVulkan1: Intel GPU (2048 MiB)", "Vulkan1: NVIDIA Test (8192 MiB)"} {
		if _, err := managedVulkanDevice([]byte(probe), host); err == nil {
			t.Fatal("ambiguous Vulkan device accepted")
		}
	}
}

func testEngineRelease(raw []byte) managedEngineRelease {
	return managedEngineRelease{ID: "llamafile", Version: "0.10.5", Platform: "linux-amd64", Accelerator: "cpu", Backend: "cpu", Executable: "llamafile",
		Artifacts: []managedEngineArtifact{{URL: "https://github.com/mozilla-ai/llamafile/releases/download/0.10.5/llamafile-0.10.5", SHA256: managedOllamaTestSHA(raw), Size: int64(len(raw)), Archive: "file"}}, License: "Apache-2.0", SourceURL: "https://github.com/mozilla-ai/llamafile"}
}

func TestManagedEngineInstallVerifiesDownloadAndCachedTree(t *testing.T) {
	engines, policy := testManagedEngines(t)
	raw := []byte("reviewed runtime binary")
	release := testEngineRelease(raw)
	requests := 0
	engines.downloadClient = &http.Client{Transport: managedOllamaRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		requests++
		return &http.Response{StatusCode: 200, ContentLength: int64(len(raw)), Body: io.NopCloser(bytes.NewReader(raw)), Header: http.Header{}}, nil
	})}
	executable, err := engines.install(context.Background(), policy, release)
	if err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatal("installation did not download")
	}
	if _, err = engines.install(context.Background(), policy, release); err != nil || requests != 1 {
		t.Fatalf("valid cache was not reused: %v", err)
	}
	if err = os.WriteFile(executable, []byte("modified binary"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err = engines.install(context.Background(), policy, release); err == nil || requests != 1 {
		t.Fatal("tampered cache accepted or silently repaired")
	}
	release.Artifacts[0].SHA256 = strings.Repeat("e", 64)
	if _, err = engines.install(context.Background(), policy, release); err == nil {
		t.Fatal("unverified download installed")
	}
}

func TestManagedEngineInstallCannotCommitAfterPolicyRevocation(t *testing.T) {
	engines, policy := testManagedEngines(t)
	raw := []byte("runtime")
	release := testEngineRelease(raw)
	engines.downloadClient = &http.Client{Transport: managedOllamaRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		replacement := *cloneCapacityPolicyState(*policy)
		replacement.Paused = explicitBool(true)
		newer, _, err := engines.policies.replace(policy.Revision, replacement)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = engines.manager.authorizePolicy(newer, false)
		return &http.Response{StatusCode: 200, ContentLength: int64(len(raw)), Body: io.NopCloser(bytes.NewReader(raw)), Header: http.Header{}}, nil
	})}
	if _, err := engines.install(context.Background(), policy, release); err == nil {
		t.Fatal("revoked installation committed")
	}
	committed := filepath.Join(engines.manager.root, "engines", release.ID+"-"+managedEnginePin(release))
	if _, err := os.Lstat(committed); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("revoked binary was published")
	}
}

func TestManagedEngineDownloadsDisabledDoesNotFetch(t *testing.T) {
	engines, policy := testManagedEngines(t)
	replacement := *cloneCapacityPolicyState(*policy)
	replacement.AutomaticDownloads = explicitBool(false)
	policy, _, _ = engines.policies.replace(policy.Revision, replacement)
	engines.downloadClient = &http.Client{Transport: managedOllamaRoundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("download started without consent")
		return nil, nil
	})}
	if _, err := engines.install(context.Background(), policy, testEngineRelease([]byte("runtime"))); !errors.Is(err, errManagedOllamaDownloadsDisabled) {
		t.Fatalf("wrong denial: %v", err)
	}
}

func engineTar(t *testing.T, headers []*tar.Header) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "engine.tar.gz")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	writer := tar.NewWriter(gz)
	for _, header := range headers {
		if err = writer.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if header.Size > 0 {
			_, err = writer.Write(bytes.Repeat([]byte("x"), int(header.Size)))
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	writer.Close()
	gz.Close()
	f.Close()
	return path
}

func TestManagedEngineArchiveRejectsTraversalAndResolvesInternalLinks(t *testing.T) {
	for _, headers := range [][]*tar.Header{
		{{Name: "../escape", Size: 1, Typeflag: tar.TypeReg}},
		{{Name: "/absolute", Size: 1, Typeflag: tar.TypeReg}},
		{{Name: "lib", Typeflag: tar.TypeSymlink, Linkname: "../../outside"}, {Name: "lib/escape", Size: 1, Typeflag: tar.TypeReg}},
		{{Name: "a", Typeflag: tar.TypeSymlink, Linkname: "b"}, {Name: "b", Typeflag: tar.TypeSymlink, Linkname: "a"}},
		{{Name: "x", Typeflag: tar.TypeReg, Size: 1}, {Name: "x", Typeflag: tar.TypeReg, Size: 1}},
		{{Name: "device", Typeflag: tar.TypeChar}},
	} {
		if err := extractManagedEngine(context.Background(), engineTar(t, headers), t.TempDir(), "llama-server", "tar.gz"); err == nil {
			t.Fatal("unsafe archive accepted")
		}
	}
	destination := t.TempDir()
	headers := []*tar.Header{{Name: "bin/lib.so", Typeflag: tar.TypeSymlink, Linkname: "lib.so.1"}, {Name: "bin/lib.so.1", Typeflag: tar.TypeSymlink, Linkname: "lib.so.2"}, {Name: "bin/lib.so.2", Typeflag: tar.TypeReg, Size: 4}}
	if err := extractManagedEngine(context.Background(), engineTar(t, headers), destination, "unused", "tar.gz"); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(filepath.Join(destination, "bin/lib.so"))
	if err != nil || !info.Mode().IsRegular() {
		t.Fatal("internal library link was not materialized")
	}
}

func TestManagedEngineZipIncludesRuntimeLibraries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "engine.zip")
	file, _ := os.Create(path)
	writer := zip.NewWriter(file)
	for _, name := range []string{"llama-server.exe", "ggml-cuda.dll"} {
		entry, _ := writer.Create(name)
		entry.Write([]byte("binary"))
	}
	writer.Close()
	file.Close()
	destination := t.TempDir()
	if err := extractManagedEngine(context.Background(), path, destination, "llama-server.exe", "zip"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(destination, "ggml-cuda.dll")); err != nil {
		t.Fatal(err)
	}
}

func TestManagedEngineRequestSurface(t *testing.T) {
	valid := []byte(`{"model":"ignored","messages":[{"role":"user","content":"test"}],"stream":false,"max_tokens":16,"metadata":{"private":"value"}}`)
	body, err := managedEngineExecutionBody(valid, "hf:qwen/qwen2.5-0.5b-instruct", true)
	if err != nil || !bytes.Contains(body, []byte(`"stream":true`)) || bytes.Contains(body, []byte("private")) {
		t.Fatalf("request rewriting failed: %v", err)
	}
	for _, input := range []string{
		`{"messages":[],"cache_prompt":true}`, `{"messages":[],"lora":[]}`, `{"messages":[],"chat_template":"custom"}`, `{"messages":[],"options":{}}`,
		`{"messages":[{"content":[{"type":"image_url","image_url":{"url":"http://localhost/private"}}]}]}`,
		`{"messages":[],"model":"a","model":"b"}`,
	} {
		if _, err := managedEngineExecutionBody([]byte(input), "model", false); err == nil {
			t.Fatalf("unsafe native input accepted: %s", input)
		}
	}
}

func TestManagedEngineDispatchAndNoPostDispatchFallback(t *testing.T) {
	engines, policy := testManagedEngines(t)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer local-test-key" {
			t.Error("wrong native endpoint or auth")
		}
		var payload map[string]any
		json.NewDecoder(r.Body).Decode(&payload)
		if payload["model"] != workerTestCanonicalModel {
			t.Error("model alias was not rewritten")
		}
		if calls.Load() == 1 {
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"choices":[{"message":{"content":"ok"}}]}`)
		} else {
			w.WriteHeader(500)
			io.WriteString(w, `{"error":"out of memory"}`)
		}
	}))
	defer server.Close()
	engines.mu.Lock()
	process := newManagedOllamaTestProcess(true)
	done := make(chan error, 1)
	engines.process = process
	engines.done = done
	go func() { done <- process.Wait(); close(done) }()
	engines.ready = true
	engines.modelID = workerTestCanonicalModel
	profile, err := engines.profile(engines.releases[0], workerTestCanonicalModel, policy)
	if err != nil {
		t.Fatal(err)
	}
	engines.profileDigest = profile.ProfileDigest
	engines.policyRevision = policy.Revision
	engines.endpoint = server.URL
	engines.key = "local-test-key"
	engines.selected = "llamafile"
	engines.mu.Unlock()
	engines.backend.loadedModels[workerTestCanonicalModel] = workerTestOllamaModel
	request := runtimeExecuteRequest{ExecutionID: "native-dispatch", ModelID: workerTestCanonicalModel, Input: []byte(`{"messages":[{"role":"user","content":"test"}]}`), MaximumOutput: 4096}
	if _, err := engines.backend.Execute(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	if _, err := engines.backend.Execute(context.Background(), request); !errors.Is(err, errRuntimeBackendOutOfMemory) {
		t.Fatalf("failure was not propagated: %v", err)
	}
	if calls.Load() != 2 {
		t.Fatal("inference was replayed")
	}
	if commands := engines.manager.commands.(*managedOllamaTestCommands); commands.starts != 0 {
		t.Fatal("Ollama fallback started after dispatch")
	}
	// An explicitly pinned SDK request must stop the native engine and use
	// Ollama, even though automatic Host requests selected llamafile.
	ollamaCalls := 0
	ollamaServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/create":
			io.WriteString(w, `{"status":"success"}`)
		case "/v1/chat/completions":
			ollamaCalls++
			io.WriteString(w, `{"choices":[{"message":{"content":"ok"}}]}`)
		default:
			t.Errorf("unexpected Ollama path: %s", r.URL.Path)
		}
	}))
	defer ollamaServer.Close()
	engines.backend.endpoint = ollamaServer.URL
	installManagedOllamaTestRuntime(t, engines.manager, strings.Repeat("a", 64))
	engines.manager.commands.(*managedOllamaTestCommands).start = func(string, []string, []string, string, io.Writer, io.Writer) (managedOllamaProcess, error) {
		return newManagedOllamaTestProcess(true), nil
	}
	engines.manager.httpClient = &http.Client{Transport: managedOllamaRoundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{}`)), Header: http.Header{}}, nil
	})}
	defer engines.manager.stop(context.Background())
	request.OllamaOnly = true
	if _, err := engines.backend.Execute(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	if ollamaCalls != 1 || calls.Load() != 2 {
		t.Fatal("explicit Ollama request was routed to native engine")
	}
}

func TestManagedEnginePauseStopsActiveProcess(t *testing.T) {
	engines, policy := testManagedEngines(t)
	process := newManagedOllamaTestProcess(true)
	done := make(chan error, 1)
	engines.process = process
	engines.done = done
	engines.ready = true
	engines.policyRevision = policy.Revision
	go func() { done <- process.Wait(); close(done) }()
	replacement := *cloneCapacityPolicyState(*policy)
	replacement.Paused = explicitBool(true)
	newer, _, _ := engines.policies.replace(policy.Revision, replacement)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := engines.enforcePolicy(ctx, newer); err != nil {
		t.Fatal(err)
	}
	if engines.process != nil {
		t.Fatal("paused native process survived")
	}
}

func TestManagedEngineProfilesStayBoundToTheModelCatalog(t *testing.T) {
	engines, _ := testManagedEngines(t)
	if err := runtimeprofile.Validate(engines.profiles); err != nil {
		t.Fatal(err)
	}
	for _, profile := range engines.profiles.Profiles {
		model, ok := engines.backend.catalog.entry(profile.Model.ID)
		if !ok || model.ContentDigest != profile.Model.ContentDigest || model.DownloadBytes != profile.Model.ArtifactBytes {
			t.Fatal("native profile drifted from model catalog")
		}
		releases, err := managedEngineReleases(hostCapability{OS: profile.Hardware.OS, Architecture: profile.Hardware.Architecture, Accelerator: profile.Hardware.AcceleratorKind, GPUs: []nvidiaGPUCapability{{}}})
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, release := range releases {
			if release.ID+"-managed" == profile.Runtime.BackendID && "sha256:"+release.Artifacts[0].SHA256 == profile.Runtime.RuntimeArtifactDigest {
				found = true
			}
		}
		if !found {
			t.Fatalf("profile %s has no compiled release", profile.ID)
		}
	}
}

func TestManagedEngineFailureFallsBackBeforeDispatch(t *testing.T) {
	engines, policy := testManagedEngines(t)
	engines.downloadClient = &http.Client{Transport: managedOllamaRoundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("download unavailable") })}
	installManagedOllamaTestRuntime(t, engines.manager, strings.Repeat("a", 64))
	process := newManagedOllamaTestProcess(true)
	commands := engines.manager.commands.(*managedOllamaTestCommands)
	commands.start = func(string, []string, []string, string, io.Writer, io.Writer) (managedOllamaProcess, error) {
		return process, nil
	}
	engines.manager.httpClient = &http.Client{Transport: managedOllamaRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/api/version" {
			t.Errorf("prompt sent during fallback: %s", r.URL.Path)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"version":"0.33.2"}`)), Header: http.Header{}}, nil
	})}
	defer engines.manager.stop(context.Background())
	if err := engines.prepare(context.Background(), policy, workerTestCanonicalModel); err != nil {
		t.Fatal(err)
	}
	status := engines.augmentStatus(engines.manager.status(policy))
	if status.ExecutionRuntime != "ollama" || status.FallbackReason != "optimized_runtime_unavailable" || !status.Running {
		t.Fatalf("fallback was not reported: %+v", status)
	}
	if commands.starts != 1 {
		t.Fatal("Ollama was not started exactly once")
	}
}

func TestManagedEngineCancellationStopsPendingDownload(t *testing.T) {
	engines, policy := testManagedEngines(t)
	started := make(chan struct{})
	finished := make(chan error, 1)
	engines.downloadClient = &http.Client{Transport: managedOllamaRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		close(started)
		<-request.Context().Done()
		return nil, request.Context().Err()
	})}
	go func() { finished <- engines.prepare(context.Background(), policy, workerTestCanonicalModel) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("download did not start")
	}
	replacement := *cloneCapacityPolicyState(*policy)
	replacement.AutomaticDownloads = explicitBool(false)
	newer, _, _ := engines.policies.replace(policy.Revision, replacement)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := engines.enforcePolicy(ctx, newer); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-finished:
		if err == nil {
			t.Fatal("cancelled preparation succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("download survived revoked consent")
	}
	if engines.manager.commands.(*managedOllamaTestCommands).starts != 0 {
		t.Fatal("cancelled preparation started a runtime")
	}
}

func TestManagedEngineInvalidCleanupDoesNotChangeRuntime(t *testing.T) {
	engines, policy := testManagedEngines(t)
	if err := engines.backend.Cleanup(context.Background(), runtimeCleanupRequest{Policy: policy, ModelIDs: []string{"not-a-model"}}); err == nil {
		t.Fatal("invalid cleanup accepted")
	}
	if err := engines.backend.deactivateModel(context.Background(), policy, "/untrusted/catalog", workerTestCanonicalModel); err == nil {
		t.Fatal("untrusted catalog accepted")
	}
	if engines.manager.commands.(*managedOllamaTestCommands).starts != 0 {
		t.Fatal("invalid cleanup started a runtime")
	}
}
