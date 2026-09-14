package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

// Progress counts completed artifact bytes, including blobs already present.
// It is not a network-usage meter and does not establish model readiness.
type managedModelDownloadProgress func(completedBytes, totalBytes uint64) error

var errManagedModelProgress = errors.New("managed model download progress is invalid")

func readManagedModelProgress(ctx context.Context, reader io.Reader, maximum uint64, progress managedModelDownloadProgress) error {
	if maximum == 0 || progress == nil {
		return errManagedModelProgress
	}
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), 64*1024)
	type layer struct{ total, completed uint64 }
	layers := map[string]layer{}
	var completed, declared uint64
	// Bound both line length and total output without buffering the whole pull.
	var lines int
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return err
		}
		lines++
		if lines > 1_000_000 {
			return errManagedModelProgress
		}
		line := scanner.Bytes()
		if validateUniqueJSONKeys(line) != nil {
			return errManagedModelProgress
		}
		var event struct {
			Status    string `json:"status"`
			Digest    string `json:"digest"`
			Total     uint64 `json:"total"`
			Completed uint64 `json:"completed"`
			Error     string `json:"error"`
		}
		if json.Unmarshal(line, &event) != nil || event.Error != "" {
			return errManagedModelProgress
		}
		if event.Digest != "" {
			if !providerDemandContentDigest.MatchString(event.Digest) {
				return errManagedModelProgress
			}
			prior, exists := layers[event.Digest]
			if !exists && len(layers) >= managedOllamaMaximumManifestLayers+1 {
				return errManagedModelProgress
			}
			// Repeated updates for a blob must not double-count its size. Regressions
			// and changed totals invalidate the stream rather than inventing progress.
			if event.Total == 0 || event.Completed > event.Total || (exists && (event.Total != prior.total || event.Completed < prior.completed)) {
				return errManagedModelProgress
			}
			if !exists {
				if event.Total > maximum-declared {
					return errManagedModelProgress
				}
				declared += event.Total
			}
			completed += event.Completed - prior.completed
			layers[event.Digest] = layer{event.Total, event.Completed}
			if err := progress(completed, maximum); err != nil {
				return err
			}
		} else if event.Total != 0 || event.Completed != 0 {
			return errManagedModelProgress
		}
		if event.Status == "success" {
			// Manifest/blob verification remains mandatory in the caller. Cached blobs
			// need not emit all counters; never fabricate a 100% progress event here.
			return ctx.Err()
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// EOF without explicit success, oversized lines, and transport errors fail.
	return errManagedModelProgress
}

func (manager *managedOllama) streamModelPull(ctx context.Context, model string, maximum uint64, progress managedModelDownloadProgress) error {
	if !ollamaModelReference.MatchString(model) || maximum == 0 || progress == nil {
		return errManagedModelProgress
	}
	body, _ := json.Marshal(struct {
		Model  string `json:"model"`
		Stream bool   `json:"stream"`
	}{model, true})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, manager.loopbackOrigin+"/api/pull", bytes.NewReader(body))
	if err != nil {
		return errManagedModelProgress
	}
	request.Header.Set("Content-Type", "application/json")
	// Origin is the manager-owned loopback server, never a browser-supplied URL
	// or a detected external runtime. Redirects are disabled on the copied client.
	client := *manager.httpClient
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(request)
	if err != nil {
		return errManagedModelProgress
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errManagedModelProgress
	}
	return readManagedModelProgress(ctx, response.Body, maximum, progress)
}
