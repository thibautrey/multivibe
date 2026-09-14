package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalArtifactValidation(t *testing.T) {
	a := localPreparationArtifact{ModelID: "author/model", Revision: strings.Repeat("a", 40), Filename: "weights/model.gguf", SHA256: strings.Repeat("b", 64), Bytes: 10}
	if _, err := a.sourceURL(); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"../model.gguf", "/model.gguf", "a%2fb.gguf", "model-00001-of-00002.gguf", "a\\b.gguf"} {
		b := a
		b.Filename = name
		if _, err := b.sourceURL(); err == nil {
			t.Fatalf("accepted %q", name)
		}
	}
	for _, raw := range []string{"http://huggingface.co/a", "https://evil.example/a", "https://hf.co.evil.example/a", "https://user@huggingface.co/a", "https://huggingface.co:443/a"} {
		u, _ := url.Parse(raw)
		if allowedLocalArtifactRedirect(u) {
			t.Fatalf("accepted %s", raw)
		}
	}
}

func TestLocalArtifactTransferAndVerifiedCache(t *testing.T) {
	payload := "synthetic GGUF fixture"
	sum := sha256.Sum256([]byte(payload))
	a := localPreparationArtifact{ModelID: "author/model", Revision: strings.Repeat("a", 40), Filename: "model.gguf", SHA256: hex.EncodeToString(sum[:]), Bytes: uint64(len(payload))}
	for _, mode := range []string{"success", "hash", "oversize", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			storage, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			manager := newManagedOllamaTestManager(t, managedOllamaConfig{})
			calls := 0
			manager.httpClient = &http.Client{Transport: managedOllamaRoundTripFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				body := payload
				if mode == "hash" {
					body = strings.Repeat("x", len(payload))
				}
				if mode == "oversize" {
					body += "x"
				}
				return &http.Response{StatusCode: 200, Header: make(http.Header), ContentLength: -1, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
			})}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			progress := func(uint64, uint64) error {
				if mode == "cancel" {
					cancel()
				}
				return nil
			}
			path, err := manager.downloadLocalArtifact(ctx, storage, a, progress)
			if mode != "success" {
				if err == nil || path != "" {
					t.Fatal("invalid transfer accepted")
				}
				files, _ := os.ReadDir(filepath.Join(storage, "local-artifacts"))
				if len(files) != 0 {
					t.Fatal("failed transfer left artifacts")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err = manager.downloadLocalArtifact(ctx, storage, a, progress); err != nil {
				t.Fatal(err)
			}
			if calls != 1 {
				t.Fatal("cache triggered network")
			}
			if err = os.WriteFile(path, []byte(strings.Repeat("z", len(payload))), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err = manager.downloadLocalArtifact(ctx, storage, a, progress); err == nil {
				t.Fatal("corrupt cache accepted")
			}
			if calls != 1 {
				t.Fatal("corrupt cache overwritten")
			}
		})
	}
}
func TestLocalArtifactCopyCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := copyLocalArtifact(ctx, io.Discard, strings.NewReader("x"), 1, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}
