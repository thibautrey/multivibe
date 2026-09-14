package main

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

var (
	errLocalPreparationDownloadBudget = errors.New("local_preparation_download_budget_exceeded")
	errLocalPreparationStorage        = errors.New("local_preparation_storage_unavailable")
	errLocalPreparationDisk           = errors.New("local_preparation_insufficient_disk")
	errLocalPreparationArtifact       = errors.New("local_preparation_artifact_not_verified")
)

type localPreparationDownloadRuntime interface {
	localPreparationCatalog() providerModelCatalog
	pullModelResultProgress(context.Context, *capacityPolicyStateDocument, string, plannedModelDownload, managedModelDownloadProgress) (managedOllamaModelRecord, bool, error)
}

// Count partial files too, not only installed catalogue entries. Never traverse a
// symlink or create/change the user's storage directory during this check.
func localPreparationStorageBytes(ctx context.Context, root string) (uint64, error) {
	if !filepath.IsAbs(root) || filepath.Clean(root) != root {
		return 0, errLocalPreparationStorage
	}
	// Check ancestors as WalkDir does not detect a symlink above its root.
	for p := root; ; p = filepath.Dir(p) {
		info, err := os.Lstat(p)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return 0, errLocalPreparationStorage
		}
		if filepath.Dir(p) == p {
			break
		}
	}
	var total uint64
	entries := 0
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		entries++
		if walkErr != nil || entries > 100000 {
			return errLocalPreparationStorage
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() || info.Size() < 0 {
			return errLocalPreparationStorage
		}
		var ok bool
		total, ok = checkedAdd(total, uint64(info.Size()))
		if !ok {
			return errLocalPreparationStorage
		}
		return nil
	})
	return total, err
}

// This internal operation consumes an exact, consented download from the pinned
// catalog. It neither activates a model nor establishes chat readiness. Dynamic
// public discovery must first resolve a verified artifact; it is not admission.
func (controller *managedProviderController) downloadLocalPreparationModel(ctx context.Context, expected *capacityPolicyStateDocument, download plannedModelDownload, digest string, progress managedModelDownloadProgress) (managedOllamaModelRecord, error) {
	var result managedOllamaModelRecord
	err := controller.withLocalPreparationRuntime(ctx, expected, true, "local-download", func(ctx context.Context, document *capacityPolicyStateDocument) error {
		runtime, ok := controller.runtime.(localPreparationDownloadRuntime)
		if !ok || progress == nil {
			return errLocalPreparationArtifact
		}
		catalog := runtime.localPreparationCatalog()
		if validateProviderModelCatalog(&catalog) != nil {
			return errLocalPreparationArtifact
		}
		entry, found := catalog.entry(download.ModelID)
		if !found || download.Bytes == 0 || download.Bytes != entry.DownloadBytes || digest != entry.ContentDigest {
			return errLocalPreparationArtifact
		}
		status := controller.runtime.status(document)
		if !status.RuntimeInstalled || !status.Running {
			return errManagedOllamaRuntimeMissing
		}
		policy, err := validateCapacityPolicy(document.Policy)
		if err != nil {
			return err
		}
		occupied, err := localPreparationStorageBytes(ctx, policy.modelStoragePath)
		if err != nil {
			return err
		}
		free, err := providerFreeDiskBytes(policy.modelStoragePath)
		if err != nil {
			return errLocalPreparationStorage
		}
		// Conservative full-artifact allowance, even with partial/cached blobs. No
		// promise of byte resumption or disk-space guarantee is made by this check.
		if occupied > policy.maxDiskBytes || download.Bytes > policy.maxDiskBytes-occupied ||
			free < policy.reserveFreeDiskBytes || download.Bytes > free-policy.reserveFreeDiskBytes {
			return errLocalPreparationDisk
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := controller.plannerState.reserveDownload(download, controller.now().UTC(), policy.maxDownloadBytesPerDay); err != nil {
			return err
		}
		record, _, err := runtime.pullModelResultProgress(ctx, document, controller.catalogPath, download, progress)
		if err != nil {
			return err
		}
		if record.CanonicalModelID != entry.CanonicalModelID || record.OllamaModel != entry.OllamaModel || record.OllamaManifestPath != entry.OllamaManifestPath || record.ManifestSHA256 != strings.TrimPrefix(entry.ContentDigest, "sha256:") {
			return errLocalPreparationArtifact
		}
		result = record
		return nil
	})
	if err != nil {
		return managedOllamaModelRecord{}, err
	}
	return result, nil
}

// Dynamic artifact preparation reuses the same policy fence, disk accounting,
// daily budget and managed downloader. It does not modify the Cloud catalog.
func (controller *managedProviderController) downloadLocalPreparationArtifact(ctx context.Context, expected *capacityPolicyStateDocument, artifact localPreparationArtifact, progress managedModelDownloadProgress) (string, error) {
	var path string
	err := controller.withLocalPreparationRuntime(ctx, expected, true, "local-artifact-download", func(ctx context.Context, document *capacityPolicyStateDocument) error {
		if _, err := artifact.sourceURL(); err != nil || progress == nil {
			return errLocalPreparationArtifact
		}
		backend, ok := controller.runtime.(*ollamaRuntimeBackend)
		if !ok {
			return errRuntimeBackendIncompatible
		}
		manager, ok := backend.pinnedRuntime.(*managedOllama)
		if !ok {
			return errRuntimeBackendIncompatible
		}
		policy, err := validateCapacityPolicy(document.Policy)
		if err != nil {
			return err
		}
		occupied, err := localPreparationStorageBytes(ctx, policy.modelStoragePath)
		if err != nil {
			return err
		}
		free, err := providerFreeDiskBytes(policy.modelStoragePath)
		if err != nil {
			return errLocalPreparationStorage
		}
		if occupied > policy.maxDiskBytes || artifact.Bytes > policy.maxDiskBytes-occupied || free < policy.reserveFreeDiskBytes || artifact.Bytes > free-policy.reserveFreeDiskBytes {
			return errLocalPreparationDisk
		}
		if err = controller.plannerState.reserveDownload(plannedModelDownload{ModelID: artifact.ModelID, Bytes: artifact.Bytes}, controller.now().UTC(), policy.maxDownloadBytesPerDay); err != nil {
			return err
		}
		path, err = manager.downloadLocalArtifact(ctx, policy.modelStoragePath, artifact, progress)
		return err
	})
	if err != nil {
		return "", err
	}
	return path, nil
}
