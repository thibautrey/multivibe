package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// Metadata only: HEAD never installs an engine or reads archive bytes. The
// existing managed download client enforces the same release redirect allowlist
// as installation. An unknown length cannot become an approval amount.
func (manager *managedOllama) quoteLocalPreparationRuntime(ctx context.Context, manifest managedOllamaDependencyManifest) (*localPreparationRuntimeQuote, error) {
	if manager == nil || manager.httpClient == nil || validateManagedOllamaDependencyManifest(manifest) != nil {
		return nil, errLocalPreparationRuntimeQuote
	}
	artifact, ok := manifest.Ollama.Artifacts[manager.platform]
	if !ok {
		return nil, errLocalPreparationRuntimeQuote
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodHead, artifact.URL, nil)
	if err != nil {
		return nil, errLocalPreparationRuntimeQuote
	}
	request.Header.Set("Accept-Encoding", "identity")
	response, err := manager.httpClient.Do(request)
	if err != nil {
		return nil, errLocalPreparationRuntimeQuote
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength <= 0 || response.ContentLength > managedOllamaArchiveMaxBytes ||
		(response.Header.Get("Content-Encoding") != "" && response.Header.Get("Content-Encoding") != "identity") {
		return nil, errLocalPreparationRuntimeQuote
	}
	quote := &localPreparationRuntimeQuote{Version: manifest.Ollama.Version, Platform: manager.platform, SHA256: artifact.SHA256, Bytes: uint64(response.ContentLength)}
	if !quote.valid() {
		return nil, errLocalPreparationRuntimeQuote
	}
	return quote, nil
}

// Private read-only preflight ingredient. It deliberately does not claim model
// compatibility, disk capacity or permission to start local execution.
func localPreparationRuntimeQuoteHandler(controller *managedProviderController, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !authorizeProviderControl(r, token) {
			http.Error(w, "not found", 404)
			return
		}
		w.Header().Set("cache-control", "no-store")
		w.Header().Set("content-type", "application/json")
		fail := func() {
			w.WriteHeader(http.StatusServiceUnavailable)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "runtime_download_quote_required"})
		}
		if controller == nil {
			fail()
			return
		}
		backend, ok := controller.runtime.(*ollamaRuntimeBackend)
		if !ok {
			fail()
			return
		}
		manager, ok := backend.pinnedRuntime.(*managedOllama)
		if !ok {
			fail()
			return
		}
		manifest, err := openManagedOllamaDependencyManifest(controller.dependencyManifestPath)
		if err != nil {
			fail()
			return
		}
		quote, err := manager.quoteLocalPreparationRuntime(r.Context(), manifest)
		if err != nil {
			fail()
			return
		}
		_ = json.NewEncoder(w).Encode(quote)
	}
}
