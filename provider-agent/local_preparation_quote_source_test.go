package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type unreadQuoteBody struct {
	t      *testing.T
	closed bool
}

func (b *unreadQuoteBody) Read([]byte) (int, error) {
	b.t.Fatal("preflight read runtime archive bytes")
	return 0, nil
}
func (b *unreadQuoteBody) Close() error { b.closed = true; return nil }

func TestRuntimeQuoteUsesOnlyPinnedHeadMetadata(t *testing.T) {
	for _, tc := range []struct {
		name     string
		status   int
		length   int64
		encoding string
		pass     bool
	}{
		{"exact", 200, 123456, "", true}, {"unknown", 200, -1, "", false}, {"empty", 200, 0, "", false},
		{"too large", 200, managedOllamaArchiveMaxBytes + 1, "", false}, {"failure", 503, 100, "", false}, {"encoded", 200, 100, "gzip", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			manifest, err := openManagedOllamaDependencyManifest(writeManagedOllamaTestDependencies(t, t.TempDir(), strings.Repeat("a", 64)))
			if err != nil {
				t.Fatal(err)
			}
			body := &unreadQuoteBody{t: t}
			calls := 0
			manager := &managedOllama{platform: "darwin-arm64", httpClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.Method != "HEAD" || r.URL.String() != manifest.Ollama.Artifacts["darwin-arm64"].URL || r.Header.Get("Accept-Encoding") != "identity" {
					t.Fatal("unexpected metadata request")
				}
				return &http.Response{StatusCode: tc.status, ContentLength: tc.length, Header: http.Header{"Content-Encoding": []string{tc.encoding}}, Body: body}, nil
			})}}
			quote, err := manager.quoteLocalPreparationRuntime(context.Background(), manifest)
			if (err == nil) != tc.pass || calls != 1 || !body.closed {
				t.Fatalf("result: %v %v calls=%d closed=%v", quote, err, calls, body.closed)
			}
			if tc.pass && (quote.Bytes != uint64(tc.length) || quote.SHA256 != strings.Repeat("a", 64) || quote.Platform != "darwin-arm64" || quote.Version != managedOllamaVersion) {
				t.Fatal(quote)
			}
		})
	}
}

func TestRuntimeQuoteRejectsUntrustedManifestWithoutNetwork(t *testing.T) {
	manifest, err := openManagedOllamaDependencyManifest(writeManagedOllamaTestDependencies(t, t.TempDir(), strings.Repeat("a", 64)))
	if err != nil {
		t.Fatal(err)
	}
	artifact := manifest.Ollama.Artifacts["darwin-arm64"]
	artifact.URL = "https://example.com/archive.tgz"
	manifest.Ollama.Artifacts["darwin-arm64"] = artifact
	manager := &managedOllama{platform: "darwin-arm64", httpClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { t.Fatal("untrusted network request"); return nil, nil })}}
	if _, err := manager.quoteLocalPreparationRuntime(context.Background(), manifest); err == nil {
		t.Fatal("accepted untrusted manifest")
	}
}

func TestRuntimeQuoteEndpointRequiresPrivateControlToken(t *testing.T) {
	handler := localPreparationRuntimeQuoteHandler(nil, strings.Repeat("a", 32))
	for _, authorized := range []bool{false, true} {
		r := httptest.NewRequest("GET", "/v1/local-preparation/runtime-quote", nil)
		if authorized {
			r.Header.Set("Authorization", "Bearer "+strings.Repeat("a", 32))
		}
		w := httptest.NewRecorder()
		handler(w, r)
		expected := 404
		if authorized {
			expected = 503
		}
		if w.Code != expected {
			t.Fatal(w.Code)
		}
	}
}
