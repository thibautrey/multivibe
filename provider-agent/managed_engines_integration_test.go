package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Explicit opt-in: executes verified upstream binaries and the catalog's public
// Qwen model. Ordinary unit tests remain offline and never launch a real engine.
func TestManagedEngineRealCPUInference(t *testing.T) {
	storage := os.Getenv("MULTIVIBE_ENGINE_SMOKE_MODEL_STORAGE")
	if storage == "" {
		t.Skip("set MULTIVIBE_ENGINE_SMOKE_MODEL_STORAGE to the verified Ollama-format Qwen model directory")
	}
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		t.Skip("CPU smoke fixture targets linux-amd64")
	}
	for _, id := range []string{"llamafile", "llama-cpp"} {
		t.Run(id, func(t *testing.T) {
			engines, policy := testManagedEngines(t)
			engines.manager.commands = execManagedOllamaCommands{}
			// Keep downloaded models read-only; this test owns only its private runtime
			// and inventory directories. All model bytes must pass the normal verifier.
			replacement := *cloneCapacityPolicyState(*policy)
			replacement.Policy.ModelStoragePath = storage
			policy, _, _ = engines.policies.replace(policy.Revision, replacement)
			entry, _ := engines.backend.catalog.entry(workerTestCanonicalModel)
			record, err := engines.manager.verifyCatalogModel(storage, entry)
			if err != nil {
				t.Fatal(err)
			}
			if err = engines.manager.recordManagedModel(storage, record); err != nil {
				t.Fatal(err)
			}
			var release managedEngineRelease
			for _, candidate := range engines.releases {
				if candidate.ID == id {
					release = candidate
				}
			}
			if release.ID == "" {
				t.Fatal("release missing")
			}
			engines.releases = []managedEngineRelease{release}
			// Optional artifact cache still goes through the production size/hash checks.
			if cache := os.Getenv("MULTIVIBE_ENGINE_SMOKE_ARTIFACT_CACHE"); cache != "" {
				engines.downloadClient = &http.Client{Transport: managedOllamaRoundTripFunc(func(request *http.Request) (*http.Response, error) {
					name := filepath.Base(request.URL.Path)
					if id == "llamafile" {
						name = "llamafile"
					}
					file, err := os.Open(filepath.Join(cache, name))
					if err != nil {
						return nil, err
					}
					stat, err := file.Stat()
					if err != nil {
						file.Close()
						return nil, err
					}
					return &http.Response{StatusCode: 200, ContentLength: stat.Size(), Body: file, Header: http.Header{}}, nil
				})}
			}
			engines.backend.loadedModels[workerTestCanonicalModel] = workerTestOllamaModel
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
			defer cancel()
			defer engines.stop(context.Background())
			started := time.Now()
			if err = engines.prepare(ctx, policy, workerTestCanonicalModel); err != nil {
				t.Fatalf("automatic preparation failed: %v", err)
			}
			status := engines.augmentStatus(managedOllamaStatus{})
			if status.ExecutionRuntime != id || !status.Running {
				t.Fatalf("native runtime did not become ready: %+v", status)
			}
			request := runtimeExecuteRequest{ExecutionID: "real-engine-smoke", ModelID: workerTestCanonicalModel,
				Input: []byte(`{"messages":[{"role":"user","content":"Reply with exactly MULTIVIBE_WORKER_OK."}],"temperature":0,"max_tokens":32}`), MaximumOutput: 64 * 1024}
			result, err := engines.backend.Execute(ctx, request)
			if err != nil {
				t.Fatal(err)
			}
			var response struct {
				Choices []struct {
					Message struct {
						Content string `json:"content"`
					} `json:"message"`
				} `json:"choices"`
				Usage struct {
					CompletionTokens uint64 `json:"completion_tokens"`
				} `json:"usage"`
			}
			if json.Unmarshal(result.Output, &response) != nil || len(response.Choices) != 1 || response.Choices[0].Message.Content != "MULTIVIBE_WORKER_OK" || response.Usage.CompletionTokens == 0 {
				t.Fatal("native qualification output or usage was invalid")
			}
			t.Logf("%s installed, loaded verified GGUF and passed qualification in %s", id, time.Since(started).Round(time.Millisecond))
			var output strings.Builder
			_, err = engines.backend.ExecuteStream(ctx, request, func(chunk runtimeExecuteChunk) error {
				_, err := io.Copy(&output, strings.NewReader(string(chunk.Output)))
				return err
			})
			if err != nil || !strings.Contains(output.String(), "[DONE]") {
				t.Fatalf("native stream did not finish: %v", err)
			}
			if err = engines.stop(ctx); err != nil {
				t.Fatal(err)
			}
			if engines.augmentStatus(managedOllamaStatus{}).Running {
				t.Fatal("native runtime survived stop")
			}
		})
	}
}
