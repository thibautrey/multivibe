package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestRuntimeMemoryEstimates(t *testing.T) {
	for _, input := range []string{"", "Host 1 2", "Host -1 2 3", "Host 1 2 3\nHost 1 2 3", "CUDA0 1 2 3", "Host 1 2 3\nOTHER 1 2 3", "Host 01 2 3", "Host 1073741825 0 0"} {
		if _, err := parseRuntimeMemory([]byte(input)); err == nil {
			t.Fatalf("accepted %q", input)
		}
	}
	for _, tc := range []struct {
		output, device, accelerator string
		budget, ram                 uint64
		state                       string
	}{
		{"Host 400 24 12", "none", "cpu", 500, 0, "compatible"},
		{"Host 400 240 12", "none", "cpu", 500, 0, "insufficient"},
		{"Host 400 24 12", "none", "cpu", 436, 0, "insufficient"},
		{"Host 400 24 12", "none", "cpu", 0, 0, "unknown"},
		{"Metal 400 24 12\nHost 100 0 0", "Metal", "metal", 500, 0, "insufficient"},
		{"Metal 400 24 12\nHost 10 0 0", "Metal", "metal", 500, 0, "compatible"},
		{"CUDA0 400 24 12\nHost 10 0 0", "CUDA0", "cuda", 500, 0, "unknown"},
		{"CUDA0 400 24 12\nHost 10 0 0", "CUDA0", "cuda", 500, 100, "compatible"},
		{"CUDA0 400 24 12\nHost 100 0 0", "CUDA0", "cuda", 500, 100, "insufficient"},
		{"Host 100 0 0", "CUDA0", "cuda", 500, 100, "unknown"},
	} {
		memory, err := parseRuntimeMemory([]byte(tc.output))
		if err != nil {
			t.Fatal(err)
		}
		state, _ := classifyRuntimeMemory(memory, hostCapability{Accelerator: tc.accelerator}, tc.device, tc.budget, tc.ram)
		if state != tc.state {
			t.Fatalf("%+v: got %s", tc, state)
		}
	}
}

func TestCompatibilityHandlerValidation(t *testing.T) {
	for _, tc := range []struct {
		body, token, content string
		status               int
	}{
		{`{"context_tokens":8192}`, "", "application/json", 404},
		{`{"context_tokens":8192}`, strings.Repeat("s", 32), "text/plain", 415},
		{`{"context_tokens":511}`, strings.Repeat("s", 32), "application/json", 400},
		{`{"context_tokens":131073}`, strings.Repeat("s", 32), "application/json", 400},
		{`{"context_tokens":8192,"context_tokens":4096}`, strings.Repeat("s", 32), "application/json", 400},
		{`{"context_tokens":8192,"other":1}`, strings.Repeat("s", 32), "application/json", 400},
		{`{"context_tokens":8192} {}`, strings.Repeat("s", 32), "application/json", 400},
		{`{"context_tokens":8192}`, strings.Repeat("s", 32), "application/json", 503},
	} {
		request := httptest.NewRequest("POST", "/v1/model-compatibility", strings.NewReader(tc.body))
		request.Header.Set("Authorization", "Bearer "+tc.token)
		request.Header.Set("content-type", tc.content)
		response := httptest.NewRecorder()
		modelCompatibilityHandler(nil, strings.Repeat("s", 32))(response, request)
		if response.Code != tc.status {
			t.Fatalf("%+v got %d", tc, response.Code)
		}
	}
}

func TestCompatibilityWithoutDownloadPermission(t *testing.T) {
	engines, policy := testManagedEngines(t)
	changed := *cloneCapacityPolicyState(*policy)
	changed.Paused = explicitBool(true)
	if _, _, err := engines.policies.replace(policy.Revision, changed); err != nil {
		t.Fatal(err)
	}
	report := engines.compatibility(context.Background(), 8192)
	if len(report.Models) == 0 {
		t.Fatal("missing unknown models")
	}
	for _, model := range report.Models {
		if model.State != "unknown" {
			t.Fatal(model)
		}
	}
	if entries, _ := os.ReadDir(filepath.Join(engines.manager.root, "engines")); len(entries) != 0 {
		t.Fatal("download attempted")
	}
}

// Opt-in verifies upstream no-allocation estimates using the same verified GGUF
// as the native engine smoke. No Start/Execute calls are used by this test.
func TestCompatibilityRealRuntime(t *testing.T) {
	storage := os.Getenv("MULTIVIBE_ENGINE_SMOKE_MODEL_STORAGE")
	if storage == "" || runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		t.Skip("requires verified local Linux smoke artifacts")
	}
	engines, policy := testManagedEngines(t)
	engines.manager.commands = execManagedOllamaCommands{}
	changed := *cloneCapacityPolicyState(*policy)
	changed.Policy.ModelStoragePath = storage
	if _, _, err := engines.policies.replace(policy.Revision, changed); err != nil {
		t.Fatal(err)
	}
	if cache := os.Getenv("MULTIVIBE_ENGINE_SMOKE_ARTIFACT_CACHE"); cache != "" {
		engines.downloadClient = &http.Client{Transport: managedOllamaRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			file, err := os.Open(filepath.Join(cache, filepath.Base(request.URL.Path)))
			if err != nil {
				return nil, err
			}
			info, err := file.Stat()
			if err != nil {
				file.Close()
				return nil, err
			}
			return &http.Response{StatusCode: 200, ContentLength: info.Size(), Body: file, Header: http.Header{}}, nil
		})}
	}
	var previous uint64
	for _, tokens := range []uint64{2048, 8192} {
		report := engines.compatibility(context.Background(), tokens)
		raw, _ := json.Marshal(report)
		t.Log(string(raw))
		if len(report.Models) != 1 || report.Models[0].State != "compatible" {
			t.Fatal("runtime estimate unavailable")
		}
		var contextMiB uint64
		for _, memory := range report.Models[0].Memory {
			contextMiB += memory.ContextMiB
		}
		if contextMiB <= previous {
			t.Fatal("runtime context estimate did not increase")
		}
		previous = contextMiB
		if engines.process != nil {
			t.Fatal("estimation started an inference server")
		}
	}
}
