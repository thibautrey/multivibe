package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRuntimeArchiveHonorsExactConsent(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		length     int64
		consent    uint64
		pass       bool
	}{
		{"exact", "abc", 3, 3, true},
		{"chunked exact", "abc", -1, 3, true},
		{"oversized header", "abcd", 4, 3, false},
		{"oversized chunked", "abcd", -1, 3, false},
		{"short chunked", "ab", -1, 3, false},
		{"zero consent", "abc", 3, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			if err := os.Mkdir(filepath.Join(root, "downloads"), 0700); err != nil {
				t.Fatal(err)
			}
			sum := sha256.Sum256([]byte(tc.body))
			digest := hex.EncodeToString(sum[:])
			manager := &managedOllama{root: root, platform: "darwin-arm64", httpClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 200, Header: make(http.Header), ContentLength: tc.length, Body: io.NopCloser(strings.NewReader(tc.body))}, nil
			})}}
			ctx := context.WithValue(context.Background(), localPreparationRuntimeQuoteKey{}, localPreparationRuntimeQuote{Version: "0.33.2", Platform: "darwin-arm64", SHA256: digest, Bytes: tc.consent})
			file, err := manager.downloadDependency(ctx, managedOllamaDependencyArtifact{URL: "https://github.com/ollama/ollama/releases/download/v0.33.2/ollama-darwin.tgz", SHA256: digest})
			if (err == nil) != tc.pass {
				t.Fatalf("success=%v, wanted %v: %v", err == nil, tc.pass, err)
			}
			if tc.pass {
				if err := os.Remove(file); err != nil {
					t.Fatal(err)
				}
			}
			files, err := os.ReadDir(filepath.Join(root, "downloads"))
			if err != nil || len(files) != 0 {
				t.Fatal("temporary archive left behind", err)
			}
		})
	}
}

func TestMissingRuntimeConsentCannotInstall(t *testing.T) {
	f := localPreparationFixture(t)
	if err := f.controller.installQuotedLocalPreparationRuntime(context.Background(), f.policy.snapshot(), nil); err != errLocalPreparationRuntimeQuote {
		t.Fatal(err)
	}
	if len(f.runtime.calls) != 0 {
		t.Fatal("runtime called without archive consent")
	}
}
