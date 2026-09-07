package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestWorkerTestCancelsInferenceBeforeClaimExpiry(t *testing.T) {
	cancelled := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			_, _ = w.Write([]byte(`{"data":[{"id":"registered/model"}]}`))
			return
		}
		<-r.Context().Done()
		close(cancelled)
	}))
	defer server.Close()
	runtimes := newMemoryRuntimeEndpointStore()
	if _, conflict, err := runtimes.replace(1, []runtimeEndpoint{{AdapterID: "manual-openai-compatible", Endpoint: server.URL}}, runtimeAdapterRegistry()); err != nil || conflict {
		t.Fatal("runtime setup failed", err)
	}
	service := newWorkerTestService(nil, http.DefaultClient, nil, nil, runtimes)
	claim := workerTestClaim{Model: "registered/model", Prompt: workerTestPrompt, TestOnly: true, ExpiresAt: time.Now().UTC().Add(11 * time.Second).Format("2006-01-02T15:04:05.000Z")}
	started := time.Now()
	if _, _, _, err := service.infer(context.Background(), cloudEnrollmentView{RuntimeFamily: "manual-openai-compatible"}, claim); err == nil {
		t.Fatal("stalled inference succeeded")
	}
	if time.Since(started) > 3*time.Second {
		t.Fatal("completion margin was not reserved")
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("runtime request was not cancelled")
	}
}
