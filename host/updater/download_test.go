package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

func fixturePart(contents string) artifactPart {
	hash := sha256.Sum256([]byte(contents))
	return artifactPart{URL: "https://github.com/thibautrey/multivibe/releases/download/v1.1.0/archive", Size: int64(len(contents)), SHA256: hex.EncodeToString(hash[:])}
}

func TestDownloadResumesAndVerifiesInterruptedPart(t *testing.T) {
	store := testStore(t)
	part := fixturePart("abcdef")
	calls := 0
	update := updater{store: store, httpClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		response := &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("abc"))}
		if calls == 2 {
			if r.Header.Get("Range") != "bytes=3-" {
				t.Fatalf("missing resume range: %s", r.Header.Get("Range"))
			}
			response.StatusCode = 206
			response.Header.Set("Content-Range", "bytes 3-5/6")
			response.Body = io.NopCloser(strings.NewReader("def"))
		}
		return response, nil
	})}}
	if _, err := update.cachedPart(context.Background(), part); err == nil {
		t.Fatal("short transfer accepted")
	}
	path, err := update.cachedPart(context.Background(), part)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "abcdef" {
		t.Fatalf("bad resumed data: %q %v", data, err)
	}
	if _, err := update.cachedPart(context.Background(), part); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatal("verified cache downloaded again")
	}
}

func TestDownloadRangeFallbackAndTamperRejection(t *testing.T) {
	for _, test := range []struct {
		name, body string
		valid      bool
	}{{"range ignored", "abcdef", true}, {"tampered", "abcdeg", false}} {
		t.Run(test.name, func(t *testing.T) {
			store := testStore(t)
			part := fixturePart("abcdef")
			path := store.cache + "/.part-" + part.SHA256
			if err := os.WriteFile(path, []byte("abc"), 0600); err != nil {
				t.Fatal(err)
			}
			update := updater{store: store, httpClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.Header.Get("Range") != "bytes=3-" {
					t.Fatal("missing resume request")
				}
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(test.body))}, nil
			})}}
			_, err := update.cachedPart(context.Background(), part)
			if (err == nil) != test.valid {
				t.Fatalf("unexpected verification: %v", err)
			}
			if !test.valid {
				if _, err := os.Stat(path); !os.IsNotExist(err) {
					t.Fatal("corrupt partial retained")
				}
			}
		})
	}
}

func TestDownloadRejectsIncorrectResumeRange(t *testing.T) {
	store := testStore(t)
	part := fixturePart("abcdef")
	path := store.cache + "/.part-" + part.SHA256
	if err := os.WriteFile(path, []byte("abc"), 0600); err != nil {
		t.Fatal(err)
	}
	update := updater{store: store, httpClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 206, Header: http.Header{"Content-Range": []string{"bytes 0-2/6"}}, Body: io.NopCloser(strings.NewReader("abc"))}, nil
	})}}
	if _, err := update.cachedPart(context.Background(), part); err == nil {
		t.Fatal("wrong range accepted")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "abc" {
		t.Fatal("invalid range changed partial file")
	}
}
