package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Import uses only a verified local GGUF. In particular FROM never contains a
// registry model name: Ollama must not implicitly pull an unconsented model.
// The returned runtime identity is not a readiness claim; inference and the chat
// route must both be checked by the preparation coordinator afterwards.
func (manager *managedOllama) importLocalPreparationArtifact(ctx context.Context, document *capacityPolicyStateDocument, artifact localPreparationArtifact, contextTokens uint64) (string, error) {
	manager.pullMu.Lock()
	defer manager.pullMu.Unlock()
	if _, err := artifact.sourceURL(); err != nil {
		return "", err
	}
	if !validCompatibilityContext(contextTokens) {
		return "", errLocalPreparationArtifact
	}
	policy, err := manager.authorizePolicy(document, false)
	if err != nil {
		return "", err
	}
	manager.mu.Lock()
	running := manager.process != nil
	manager.mu.Unlock()
	if !running {
		return "", errManagedOllamaRuntimeMissing
	}
	binary, _, err := manager.installedRuntime()
	if err != nil {
		return "", err
	}
	if _, err = localPreparationStorageBytes(ctx, policy.modelStoragePath); err != nil {
		return "", err
	}
	source := filepath.Join(policy.modelStoragePath, "local-artifacts", artifact.SHA256+".gguf")
	hash, err := hashManagedOllamaStableRegularFile(source, int64(artifact.Bytes), int64(artifact.Bytes))
	if err != nil || hash != artifact.SHA256 {
		return "", errLocalPreparationArtifact
	}
	// Ollama may copy the artifact into its blob store. Reserve the complete copy,
	// even on filesystems where it can reuse blocks; weights alone are not RAM fit.
	occupied, err := localPreparationStorageBytes(ctx, policy.modelStoragePath)
	if err != nil {
		return "", err
	}
	free, err := providerFreeDiskBytes(policy.modelStoragePath)
	if err != nil {
		return "", errLocalPreparationStorage
	}
	if occupied > policy.maxDiskBytes || artifact.Bytes > policy.maxDiskBytes-occupied || free < policy.reserveFreeDiskBytes || artifact.Bytes > free-policy.reserveFreeDiskBytes {
		return "", errLocalPreparationDisk
	}
	directory, err := os.MkdirTemp(filepath.Join(policy.modelStoragePath, "local-artifacts"), ".import-")
	if err != nil {
		return "", errLocalPreparationStorage
	}
	defer os.Remove(directory)
	// A relative, fixed source name avoids Modelfile path interpolation. The
	// private staging link never moves, deletes or modifies the original artifact.
	input := filepath.Join(directory, "model.gguf")
	if err = os.Link(source, input); err != nil {
		return "", errLocalPreparationStorage
	}
	defer os.Remove(input)
	hash, err = hashManagedOllamaStableRegularFile(input, int64(artifact.Bytes), int64(artifact.Bytes))
	if err != nil || hash != artifact.SHA256 {
		return "", errLocalPreparationArtifact
	}
	modelfile := filepath.Join(directory, "Modelfile")
	if err = os.WriteFile(modelfile, []byte("FROM ./model.gguf\nPARAMETER num_ctx "+strconv.FormatUint(contextTokens, 10)+"\n"), 0600); err != nil {
		return "", errLocalPreparationStorage
	}
	defer os.Remove(modelfile)
	var nonce [16]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return "", errLocalPreparationStorage
	}
	// Unique names never replace a user's existing model or change Cloud admission.
	model := "multivibe-local-" + hex.EncodeToString(nonce[:]) + ":latest"
	operation, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	if err = operation.Err(); err != nil {
		return "", err
	}
	if _, err = manager.authorizePolicy(document, false); err != nil {
		return "", err
	}
	_, err = manager.commands.Run(operation, binary, []string{"create", model, "-f", modelfile}, manager.commandEnvironment(policy.modelStoragePath), directory, 256*1024)
	if operation.Err() != nil {
		return "", operation.Err()
	}
	if err != nil {
		return "", errors.New("local_preparation_import_failed")
	}
	if _, err = manager.authorizePolicy(document, false); err != nil {
		return "", err
	}
	return model, nil
}

func (controller *managedProviderController) importLocalPreparationArtifact(ctx context.Context, expected *capacityPolicyStateDocument, artifact localPreparationArtifact, contextTokens uint64) (string, error) {
	var result string
	err := controller.withLocalPreparationRuntime(ctx, expected, false, "local-import", func(ctx context.Context, document *capacityPolicyStateDocument) error {
		backend, ok := controller.runtime.(*ollamaRuntimeBackend)
		if !ok {
			return errRuntimeBackendIncompatible
		}
		manager, ok := backend.pinnedRuntime.(*managedOllama)
		if !ok {
			return errRuntimeBackendIncompatible
		}
		var err error
		result, err = manager.importLocalPreparationArtifact(ctx, document, artifact, contextTokens)
		return err
	})
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(result, "multivibe-local-") {
		return "", errLocalPreparationArtifact
	}
	return result, nil
}
