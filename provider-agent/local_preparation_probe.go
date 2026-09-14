package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var localPreparationModelIdentity = regexp.MustCompile(`^multivibe-local-[a-f0-9]{32}:latest$`)
var errLocalPreparationProbe = errors.New("local_preparation_probe_failed")

// A synthetic response proves inference only, not chat-route registration or quality.
// The caller must retain the policy fence and attest ownership of the runtime.
func probeLocalPreparationRuntime(ctx context.Context, client *http.Client, origin, model string) (string, error) {
	endpoint, err := url.Parse(origin)
	if err != nil || endpoint.Scheme != "http" || (endpoint.Hostname() != "127.0.0.1" && endpoint.Hostname() != "::1") || endpoint.User != nil || endpoint.Path != "" || endpoint.RawQuery != "" || endpoint.Fragment != "" || !localPreparationModelIdentity.MatchString(model) || client == nil {
		return "", errLocalPreparationProbe
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	payload, _ := json.Marshal(map[string]any{"model": model, "messages": []map[string]string{{"role": "user", "content": "Reply with the word OK."}}, "max_tokens": 32, "stream": false})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, origin+"/v1/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return "", errLocalPreparationProbe
	}
	request.Header.Set("Content-Type", "application/json")
	localClient := *client
	localClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := localClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", errLocalPreparationProbe
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", errLocalPreparationProbe
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(raw) > 65536 {
		return "", errLocalPreparationProbe
	}
	var result struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if json.Unmarshal(raw, &result) != nil || len(result.Choices) == 0 {
		return "", errLocalPreparationProbe
	}
	output := strings.TrimSpace(result.Choices[0].Message.Content)
	if output == "" || len(output) > 4096 {
		return "", errLocalPreparationProbe
	}
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	return output, nil
}

func (controller *managedProviderController) testLocalPreparationRuntime(ctx context.Context, expected *capacityPolicyStateDocument, model string) (string, error) {
	var output string
	err := controller.withLocalPreparationRuntime(ctx, expected, false, "local-test", func(ctx context.Context, document *capacityPolicyStateDocument) error {
		backend, ok := controller.runtime.(*ollamaRuntimeBackend)
		if !ok {
			return errRuntimeBackendIncompatible
		}
		manager, ok := backend.pinnedRuntime.(*managedOllama)
		if !ok {
			return errRuntimeBackendIncompatible
		}
		manager.pullMu.Lock()
		defer manager.pullMu.Unlock()
		if _, err := manager.authorizePolicy(document, false); err != nil {
			return err
		}
		manager.mu.Lock()
		running := manager.process != nil
		manager.mu.Unlock()
		if !running {
			return errManagedOllamaRuntimeMissing
		}
		if _, _, err := manager.installedRuntime(); err != nil {
			return err
		}
		var err error
		output, err = probeLocalPreparationRuntime(ctx, manager.httpClient, manager.executionOrigin(), model)
		if err != nil {
			return err
		}
		_, err = manager.authorizePolicy(document, false)
		return err
	})
	if err != nil {
		return "", err
	}
	return output, nil
}
