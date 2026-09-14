package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Exercise production orchestration with a signed test release and a harmless
// executable installer fixture. This does not substitute for a real package
// installation test: the fixture deliberately never touches system services.
func TestLinuxAutomaticSignedReleaseFlow(t *testing.T) {
	for _, failInstall := range []bool{false, true} {
		t.Run(fmt.Sprintf("installer_failure_%v", failInstall), func(t *testing.T) {
			store := testStore(t)
			t.Setenv("MULTIVIBE_TEST_INSTALL_MARKER", filepath.Join(store.directory, "installed"))
			script := "#!/bin/sh\nset -eu\n[ \"$1\" = --automatic-update ]\nprintf invoked > \"$MULTIVIBE_TEST_INSTALL_MARKER\"\n"
			if failInstall {
				script += "exit 1\n"
			}
			var archive bytes.Buffer
			compressed := gzip.NewWriter(&archive)
			writer := tar.NewWriter(compressed)
			if err := writer.WriteHeader(&tar.Header{Name: "release/install.sh", Mode: 0755, Size: int64(len(script)), Typeflag: tar.TypeReg}); err != nil {
				t.Fatal(err)
			}
			if _, err := writer.Write([]byte(script)); err != nil {
				t.Fatal(err)
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			if err := compressed.Close(); err != nil {
				t.Fatal(err)
			}
			now := time.Now()
			document := validDocument(now)
			target := document.Targets["linux-amd64"]
			target.Size = int64(archive.Len())
			target.SHA256 = fmt.Sprintf("%x", sha256.Sum256(archive.Bytes()))
			document.Targets["linux-amd64"] = target
			envelope := signedFixture(t, document)
			var drained, ready, resumed atomic.Bool
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("x-admin-token") != strings.Repeat("a", 32) {
					w.WriteHeader(401)
					return
				}
				switch r.URL.Path {
				case "/admin/host-update/drain":
					drained.Store(true)
					io.WriteString(w, `{}`)
				case "/admin/host-update/readiness":
					ready.Store(drained.Load())
					io.WriteString(w, `{"ready":true}`)
				case "/admin/host-update/resume":
					resumed.Store(true)
					io.WriteString(w, `{}`)
				default:
					w.WriteHeader(404)
				}
			}))
			defer server.Close()
			t.Setenv("MULTIVIBE_CONTROL_PLANE_PORT", strings.Split(strings.TrimPrefix(server.URL, "http://"), ":")[1])
			credentials := `{"schema_version":"multivibe-host-credentials-v1","admin_token":"` + strings.Repeat("a", 32) + `","proxy_api_key":"` + strings.Repeat("b", 32) + `"}`
			if err := os.WriteFile(filepath.Join(store.directory, "host-credentials.json"), []byte(credentials), 0600); err != nil {
				t.Fatal(err)
			}
			downloads := 0
			update := updater{store: store, now: time.Now, httpClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				data := envelope
				if r.URL.String() == target.URL {
					data = archive.Bytes()
					downloads++
				}
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(data))}, nil
			})}}
			state, _ := defaultState("1.0.0")
			err := runAutomatic(context.Background(), &update, &state)
			if (err != nil) != failInstall {
				t.Fatalf("unexpected result: %v", err)
			}
			if !drained.Load() || !ready.Load() || downloads != 1 {
				t.Fatal("release did not traverse download and drain readiness")
			}
			if _, err := os.Stat(os.Getenv("MULTIVIBE_TEST_INSTALL_MARKER")); err != nil {
				t.Fatal("installer was not executed", err)
			}
			saved, err := store.load("1.0.0")
			if err != nil {
				t.Fatal(err)
			}
			if failInstall {
				if saved.CurrentVersion != "1.0.0" || saved.Status != "failed" || saved.LastErrorCode != "installation_failed" || !resumed.Load() {
					t.Fatalf("failure recovery incorrect: %#v", saved)
				}
			} else if saved.CurrentVersion != "1.2.3" || saved.Status != "current" || saved.Target != nil || saved.LastInstalledAt == "" || resumed.Load() {
				t.Fatalf("success state incorrect: %#v", saved)
			}
			extracts, _ := filepath.Glob(filepath.Join(store.cache, ".extract-*"))
			if len(extracts) != 0 {
				t.Fatal("extraction staging leaked")
			}
		})
	}
}
