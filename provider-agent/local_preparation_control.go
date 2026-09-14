package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
)

// This bridge is private to the authenticated supervisor. It is not a browser
// API: the server-side coordinator owns preflight, exact consent and sequencing.
// No arbitrary URL, filesystem path, command, runtime settings or Cloud route
// can be supplied here. Each operation rechecks the complete policy fence.
type localPreparationOperation struct {
	Operation      string                   `json:"operation"`
	PolicyRevision uint64                   `json:"policy_revision"`
	Artifact       localPreparationArtifact `json:"artifact"`
	ContextTokens  uint64                   `json:"context_tokens"`
}
type localPreparationEvent struct {
	Type           string `json:"type"`
	CompletedBytes uint64 `json:"completed_bytes,omitempty"`
	TotalBytes     uint64 `json:"total_bytes,omitempty"`
	RuntimeModel   string `json:"runtime_model,omitempty"`
	Error          string `json:"error,omitempty"`
}
type localPreparationExecute func(context.Context, localPreparationOperation, managedModelDownloadProgress) (string, error)

func localPreparationControlHandler(controller *managedProviderController, token string) http.HandlerFunc {
	return localPreparationOperationHandler(token, func(ctx context.Context, input localPreparationOperation, progress managedModelDownloadProgress) (string, error) {
		if controller == nil {
			return "", errRuntimeBackendIncompatible
		}
		expected := controller.policy.snapshot()
		if expected == nil || expected.Revision != input.PolicyRevision {
			return "", errManagedControllerFence
		}
		switch input.Operation {
		case "install":
			return "", controller.installLocalPreparationRuntime(ctx, expected)
		case "start":
			return "", controller.startLocalPreparationRuntime(ctx, expected)
		case "download":
			_, err := controller.downloadLocalPreparationArtifact(ctx, expected, input.Artifact, progress)
			return "", err
		case "import":
			return controller.importLocalPreparationArtifact(ctx, expected, input.Artifact, input.ContextTokens)
		}
		return "", errLocalPreparationArtifact
	})
}
func localPreparationOperationHandler(token string, execute localPreparationExecute) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !authorizeProviderControl(r, token) {
			http.Error(w, "not found", 404)
			return
		}
		w.Header().Set("cache-control", "no-store")
		if r.Header.Get("content-type") != "application/json" {
			http.Error(w, "invalid request", 415)
			return
		}
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4096))
		if err != nil || validateUniqueJSONKeys(raw) != nil {
			http.Error(w, "invalid request", 400)
			return
		}
		var input localPreparationOperation
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || ensureJSONEOF(decoder) != nil || input.PolicyRevision == 0 || !validCompatibilityContext(input.ContextTokens) {
			http.Error(w, "invalid request", 400)
			return
		}
		if _, err = input.Artifact.sourceURL(); err != nil {
			http.Error(w, "invalid artifact", 400)
			return
		}
		switch input.Operation {
		case "install", "start", "download", "import":
		default:
			http.Error(w, "invalid operation", 400)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Hour)
		defer cancel()
		w.Header().Set("content-type", "application/x-ndjson")
		response := http.NewResponseController(w)
		encoder := json.NewEncoder(w)
		emit := func(event localPreparationEvent) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			// Backpressure must not hold the runtime lock indefinitely after the server
			// stops reading progress. Clearing the deadline permits the next long stage.
			_ = response.SetWriteDeadline(time.Now().Add(15 * time.Second))
			if err := encoder.Encode(event); err != nil {
				cancel()
				return err
			}
			if err := response.Flush(); err != nil {
				cancel()
				return err
			}
			_ = response.SetWriteDeadline(time.Time{})
			return nil
		}
		var previous uint64
		model, operationErr := execute(ctx, input, func(completed, total uint64) error {
			if input.Operation != "download" || total != input.Artifact.Bytes || completed > total || completed < previous {
				return errLocalPreparationArtifact
			}
			previous = completed
			return emit(localPreparationEvent{Type: "progress", CompletedBytes: completed, TotalBytes: total})
		})
		if operationErr != nil {
			_ = emit(localPreparationEvent{Type: "error", Error: localPreparationPublicError(operationErr)})
			return
		}
		_ = emit(localPreparationEvent{Type: "complete", RuntimeModel: model})
	}
}
func localPreparationPublicError(err error) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "cancelled"
	case errors.Is(err, context.DeadlineExceeded):
		return "preparation_timeout"
	case errors.Is(err, errManagedControllerConsent), errors.Is(err, errManagedOllamaPaused), errors.Is(err, errManagedOllamaDownloadsDisabled):
		return "host_permission_required"
	case errors.Is(err, errManagedControllerFence), errors.Is(err, errManagedControllerSuperseded):
		return "new_preflight_required"
	case errors.Is(err, errLocalPreparationStorage):
		return "storage_unavailable"
	case errors.Is(err, errLocalPreparationDisk):
		return "insufficient_disk"
	case errors.Is(err, errLocalPreparationDownloadBudget):
		return "download_budget_exceeded"
	case errors.Is(err, errLocalPreparationArtifact):
		return "artifact_verification_failed"
	default:
		return "local_preparation_failed"
	}
}
