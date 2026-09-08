package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestWorkerTestCancelsInferenceBeforeClaimExpiry(t *testing.T) {
	cancelled := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case <-r.Context().Done():
		case <-time.After(4 * time.Second):
		}
		close(cancelled)
	}))
	defer server.Close()
	managed := &runtimeEndpoint{AdapterID: managedWorkerAdapterID, Endpoint: server.URL}
	service := newWorkerTestService(nil, http.DefaultClient, nil, nil, managed, &workerTestManagedRuntimeStub{})
	claim := workerTestClaim{Model: workerTestCanonicalModel, Prompt: workerTestPrompt, TestOnly: true, ExpiresAt: time.Now().UTC().Add(11 * time.Second).Format("2006-01-02T15:04:05.000Z")}
	started := time.Now()
	if _, _, _, err := service.infer(context.Background(), claim); err == nil {
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
