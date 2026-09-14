package main

import (
	"context"
	"errors"
)

// Archive consent is separate from model consent. The URL is always taken from
// the pinned Host manifest, never from a browser or a model repository.
type localPreparationRuntimeQuote struct {
	Version  string `json:"version"`
	Platform string `json:"platform"`
	SHA256   string `json:"sha256"`
	Bytes    uint64 `json:"bytes"`
}
type localPreparationRuntimeQuoteKey struct{}

var errLocalPreparationRuntimeQuote = errors.New("runtime_download_quote_required")

func (q *localPreparationRuntimeQuote) valid() bool {
	return q != nil && q.Version != "" && q.Platform != "" && validManagedOllamaSHA256(q.SHA256) && q.Bytes > 0 && q.Bytes <= uint64(managedOllamaArchiveMaxBytes)
}

// Reuse the existing install and download accounting machinery. The context
// carries the exact byte ceiling to the downloader, including a bundle fallback.
func (controller *managedProviderController) installQuotedLocalPreparationRuntime(ctx context.Context, expected *capacityPolicyStateDocument, quote *localPreparationRuntimeQuote) error {
	if !quote.valid() {
		return errLocalPreparationRuntimeQuote
	}
	consent := *quote
	return controller.withLocalPreparationRuntime(ctx, expected, true, "local-install", func(ctx context.Context, policy *capacityPolicyStateDocument) error {
		backend, ok := controller.runtime.(*ollamaRuntimeBackend)
		if !ok {
			return errRuntimeBackendIncompatible
		}
		manager, ok := backend.pinnedRuntime.(*managedOllama)
		if !ok {
			return errRuntimeBackendIncompatible
		}
		manifest, err := openManagedOllamaDependencyManifest(controller.dependencyManifestPath)
		if err != nil {
			return errLocalPreparationRuntimeQuote
		}
		artifact, ok := manifest.Ollama.Artifacts[manager.platform]
		if !ok || consent.Platform != manager.platform || consent.Version != manifest.Ollama.Version || consent.SHA256 != artifact.SHA256 {
			return errLocalPreparationRuntimeQuote
		}
		if _, record, err := manager.installedRuntime(); err == nil {
			if record.ArchiveSHA256 != consent.SHA256 {
				return errLocalPreparationRuntimeQuote
			}
			return nil
		} else if !errors.Is(err, errManagedOllamaRuntimeMissing) {
			return err
		}
		capacity, err := validateCapacityPolicy(policy.Policy)
		if err != nil {
			return err
		}
		// Reserve conservatively before installation: even an unavailable bundle may
		// fall back to the network. Failed/partial attempts retain their reservation.
		if err := controller.plannerState.reserveDownload(plannedModelDownload{ModelID: "runtime/ollama-" + consent.Version + "-" + consent.Platform, Bytes: consent.Bytes}, controller.now().UTC(), capacity.maxDownloadBytesPerDay); err != nil {
			return err
		}
		_, err = manager.ensureRuntimePinned(context.WithValue(ctx, localPreparationRuntimeQuoteKey{}, consent), policy, manifest)
		return err
	})
}
