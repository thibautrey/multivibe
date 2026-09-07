package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/thibautrey/multivibe/provider-agent/runtimeprofile"
)

func TestReviewedProfilesBindHardwarePolicyAndNativeParameters(t *testing.T) {
	root, _ := filepath.Abs("../packaging")
	catalog, err := openProviderModelCatalog(filepath.Join(root, "provider-model-catalog.json"))
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := openManagedOllamaDependencyManifest(filepath.Join(root, "provider-host-dependencies.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, host := range []hostCapability{
		{OS: "linux", Architecture: "arm64", Accelerator: "cpu", AcceleratorMemoryBytes: 4 << 30},
		{OS: "linux", Architecture: "amd64", Accelerator: "cpu", AcceleratorMemoryBytes: 4 << 30},
		{OS: "linux", Architecture: "amd64", Accelerator: "cuda", AcceleratorMemoryBytes: 8 << 30},
		{OS: "windows", Architecture: "amd64", Accelerator: "cuda", AcceleratorMemoryBytes: 8 << 30},
		{OS: "darwin", Architecture: "arm64", Accelerator: "metal", AcceleratorMemoryBytes: 4 << 30},
	} {
		t.Run(host.OS+"-"+host.Architecture+"-"+host.Accelerator, func(t *testing.T) {
			contextTokens, batch, offload := uint64(8192), uint64(128), uint64(24)
			if host.Accelerator == "cpu" {
				contextTokens, batch, offload = 2048, 32, 0
			}
			backend := &ollamaRuntimeBackend{catalog: catalog, descriptor: runtimeBackendDescriptor{ID: runtimeBackendOllamaID,
				Launch: runtimeBackendLaunchAllowlist{Resources: runtimeBackendResourceBounds{MaximumContextTokens: 131072},
					Provenance: runtimeBackendProvenance{ArtifactSHA256: map[string]string{host.OS + "-" + host.Architecture: manifest.Ollama.Artifacts[host.OS+"-"+host.Architecture].SHA256}}}}}
			if err := backend.configureReviewedProfiles(filepath.Join(root, "provider-runtime-profiles.json"), host); err != nil {
				t.Fatal(err)
			}
			percent := uint8(100)
			policy := &capacityPolicyStateDocument{Policy: capacityPolicyDocument{GPUVRAMPercent: &percent}}
			model := catalog.Models[0].CanonicalModelID
			if err := backend.bindReviewedProfile(model, policy, contextTokens); err != nil {
				t.Fatal(err)
			}
			if host.Accelerator == "cpu" && backend.bindReviewedProfile(model, policy, 8192) == nil {
				t.Fatal("CPU profile accepted oversized context")
			}
			profile := backend.loadedProfiles[model]
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.URL.Path != "/api/create" {
					t.Error("expected native create")
				}
				var body struct {
					Model      string            `json:"model"`
					From       string            `json:"from"`
					Parameters map[string]uint64 `json:"parameters"`
				}
				if json.NewDecoder(r.Body).Decode(&body) != nil || body.Model != reviewedAlias(profile) || body.From != catalog.Models[0].OllamaModel ||
					body.Parameters["num_ctx"] != contextTokens || body.Parameters["num_batch"] != batch || body.Parameters["num_gpu"] != offload {
					t.Error("reviewed parameters were not applied")
				}
				_, _ = w.Write([]byte(`{"status":"success"}`))
			}))
			defer server.Close()
			backend.endpoint = server.URL
			backend.client = server.Client()
			if _, err := backend.prepareReviewedAlias(context.Background(), model, catalog.Models[0].OllamaModel); err != nil {
				t.Fatal(err)
			}
			if calls != 1 {
				t.Fatal("native configuration missing")
			}
			percent = 1
			if backend.bindReviewedProfile(model, policy, contextTokens) == nil {
				t.Fatal("memory policy bypassed")
			}
			percent = 100
			backend.descriptor.Launch.Provenance.ArtifactSHA256[host.OS+"-"+host.Architecture] = "bad"
			if backend.bindReviewedProfile(model, policy, contextTokens) == nil {
				t.Fatal("runtime digest bypassed")
			}
		})
	}
}

func TestReviewedExecutionRejectsResourceOverrides(t *testing.T) {
	for _, field := range []string{"options", "num_ctx", "num_batch", "num_gpu", "num_parallel", "keep_alive"} {
		if _, err := reviewedOllamaExecutionBody([]byte(`{"`+field+`":1}`), "test:model", false); err == nil {
			t.Fatal("accepted override", field)
		}
	}
	backend := &ollamaRuntimeBackend{reviewedProfiles: &runtimeprofile.Catalog{}, loadedProfiles: make(map[string]runtimeprofile.Profile)}
	if _, err := backend.prepareReviewedAlias(context.Background(), "unloaded", "model"); err == nil {
		t.Fatal("unreviewed execution accepted")
	}
}
