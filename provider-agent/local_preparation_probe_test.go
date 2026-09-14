package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLocalPreparationProbe(t *testing.T) {
	model := "multivibe-local-" + strings.Repeat("a", 32) + ":latest"
	for _, body := range []string{`{"choices":[{"message":{"content":"OK"}}]}`, `{"choices":[]}`, `{"choices":[{"message":{"content":" "}}]}`, `invalid`, strings.Repeat("x", 65537)} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != "POST" || r.URL.Path != "/v1/chat/completions" {
				t.Error("unexpected request")
			}
			w.Write([]byte(body))
		}))
		output, err := probeLocalPreparationRuntime(context.Background(), server.Client(), server.URL, model)
		server.Close()
		if strings.Contains(body, `"OK"`) {
			if err != nil || output != "OK" {
				t.Fatalf("valid response: %q %v", output, err)
			}
		} else if err == nil {
			t.Fatal("invalid response accepted")
		}
	}
	for _, origin := range []string{"https://example.com", "http://localhost:11434", "http://user@127.0.0.1:11434", "http://127.0.0.1/path"} {
		if _, err := probeLocalPreparationRuntime(context.Background(), http.DefaultClient, origin, model); err == nil {
			t.Fatal("unsafe origin accepted")
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "https://example.com", 302) }))
	defer server.Close()
	if _, err := probeLocalPreparationRuntime(context.Background(), server.Client(), server.URL, model); err == nil {
		t.Fatal("redirect accepted")
	}
	if _, err := probeLocalPreparationRuntime(context.Background(), server.Client(), server.URL, "user-model"); err == nil {
		t.Fatal("unowned identity accepted")
	}
}
