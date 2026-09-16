package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestResolveHostControlPlanePort(t *testing.T) {
	tests := []struct {
		name         string
		goos         string
		controlPlane string
		hostPort     string
		want         string
		wantError    bool
	}{
		{name: "macOS default", goos: "darwin", want: "1456"},
		{name: "macOS ignores edge port", goos: "darwin", hostPort: "1455", want: "1456"},
		{name: "explicit control plane", goos: "darwin", controlPlane: "1460", hostPort: "1455", want: "1460"},
		{name: "other platform default", goos: "linux", want: "1455"},
		{name: "other platform host port", goos: "windows", hostPort: "2480", want: "2480"},
		{name: "invalid control plane", goos: "linux", controlPlane: "not-a-port", wantError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := resolveHostControlPlanePort(test.goos, test.controlPlane, test.hostPort)
			if test.wantError {
				if err == nil {
					t.Fatal("invalid port was accepted")
				}
				return
			}
			if err != nil || got != test.want {
				t.Fatalf("resolveHostControlPlanePort() = %q, %v; want %q", got, err, test.want)
			}
		})
	}
}

func TestHostCredentialsAcceptApplicationCredentialSchema(t *testing.T) {
	data := []byte(`{"schema_version":"multivibe-host-credentials-v1","admin_token":"admin","proxy_api_key":"proxy"}`)
	var credentials hostCredentials
	if err := decodeStrictJSON(data, &credentials); err != nil {
		t.Fatalf("current application credentials were rejected: %v", err)
	}
	if credentials.SchemaVersion != "multivibe-host-credentials-v1" || credentials.AdminToken != "admin" || credentials.ProxyAPIKey != "proxy" {
		t.Fatalf("credentials were decoded incorrectly: %#v", credentials)
	}
}

func TestHostCredentialsRejectUnknownFields(t *testing.T) {
	data := []byte(`{"schema_version":"multivibe-host-credentials-v1","admin_token":"admin","proxy_api_key":"proxy","unexpected":"value"}`)
	var credentials hostCredentials
	if err := decodeStrictJSON(data, &credentials); err == nil {
		t.Fatal("unknown credential field was accepted")
	}
}

func writeTarFixture(t *testing.T, name string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fixture.tar.gz")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	gzipWriter := gzip.NewWriter(file)
	tarWriter := tar.NewWriter(gzipWriter)
	contents := []byte("#!/bin/sh\n")
	if err := tarWriter.WriteHeader(&tar.Header{Name: name, Mode: 0o555, Size: int64(len(contents)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tarWriter.Write(contents); err != nil {
		t.Fatal(err)
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestExtractLinuxArchive(t *testing.T) {
	root, err := extractLinuxArchive(writeTarFixture(t, "multivibe-host_1.0.0/install.sh"), t.TempDir())
	if err != nil || filepath.Base(root) != "multivibe-host_1.0.0" {
		t.Fatalf("valid archive failed: %q %v", root, err)
	}
}

func TestExtractLinuxArchiveRejectsTraversal(t *testing.T) {
	if _, err := extractLinuxArchive(writeTarFixture(t, "../install.sh"), t.TempDir()); err == nil {
		t.Fatal("archive traversal accepted")
	}
}

func writeWindowsZipFixture(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fixture.zip")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	directory := &zip.FileHeader{Name: "multivibe-host_1.0.0_windows_amd64/"}
	directory.SetMode(os.ModeDir | 0o700)
	if _, err := writer.CreateHeader(directory); err != nil {
		t.Fatal(err)
	}
	installer := &zip.FileHeader{Name: "multivibe-host_1.0.0_windows_amd64/install.ps1"}
	installer.SetMode(0o600)
	entry, err := writer.CreateHeader(installer)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := entry.Write([]byte("Write-Output ready\n")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestSafeWindowsArchivePath(t *testing.T) {
	tests := map[string]bool{
		"multivibe-host_1.0.0_windows_amd64/":            true,
		"multivibe-host_1.0.0_windows_amd64/install.ps1": true,
		"":                                     false,
		"/install.ps1":                         false,
		"multivibe-host_1.0.0_windows_amd64//": false,
		"multivibe-host_1.0.0_windows_amd64/../escape": false,
		"multivibe-host_1.0.0_windows_amd64\\escape":   false,
		"C:/escape": false,
		"multivibe-host_1.0.0_windows_amd64/./install.ps1": false,
	}
	for name, expected := range tests {
		if actual := safeWindowsArchivePath(name); actual != expected {
			t.Errorf("safeWindowsArchivePath(%q) = %v, want %v", name, actual, expected)
		}
	}
}

func TestExtractWindowsArchiveAllowsDirectoryEntries(t *testing.T) {
	destination := t.TempDir()
	root, err := extractWindowsArchive(writeWindowsZipFixture(t), destination)
	if err != nil || filepath.Base(root) != "multivibe-host_1.0.0_windows_amd64" {
		t.Fatalf("valid Windows archive failed: %q %v", root, err)
	}
	contents, err := os.ReadFile(filepath.Join(root, "install.ps1"))
	if err != nil || string(contents) != "Write-Output ready\n" {
		t.Fatalf("staged installer is invalid: %q %v", contents, err)
	}
}

func TestWriteDockerOverride(t *testing.T) {
	path := filepath.Join(t.TempDir(), "override.yml")
	reference := "ghcr.io/thibautrey/multivibe-host@sha256:" + string(make([]byte, 64))
	// NUL bytes must fail the strict canonical image reference.
	if err := writeDockerOverride(path, reference); err == nil {
		t.Fatal("invalid Docker reference accepted")
	}
	valid := "ghcr.io/thibautrey/multivibe-host@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if err := writeDockerOverride(path, valid); err != nil {
		t.Fatal(err)
	}
	contents, _ := os.ReadFile(path)
	if string(contents) != "# Managed by MultiVibe Host updater\nservices:\n  multivibe-host:\n    image: "+valid+"\n" {
		t.Fatalf("unexpected override: %q", contents)
	}
}

func TestApplyResumesAfterReadinessCancellation(t *testing.T) {
	store := testStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var began, resumed atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/admin/host-update/drain":
			began.Store(true)
			w.Write([]byte(`{}`))
		case "/admin/host-update/readiness":
			if began.Load() {
				cancel()
			}
			w.Write([]byte(`{"ready":false,"quiet":true}`))
		case "/admin/host-update/resume":
			resumed.Store(true)
			w.Write([]byte(`{}`))
		default:
			t.Errorf("unexpected route: %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	t.Setenv("MULTIVIBE_CONTROL_PLANE_PORT", strings.Split(strings.TrimPrefix(server.URL, "http://"), ":")[1])
	credentials := `{"schema_version":"multivibe-host-credentials-v1","admin_token":"` + strings.Repeat("a", 32) + `","proxy_api_key":"` + strings.Repeat("b", 32) + `"}`
	if err := os.WriteFile(filepath.Join(store.directory, "host-credentials.json"), []byte(credentials), 0600); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(store.cache, "archive")
	contents := []byte("verified archive; installer must never run")
	if err := os.WriteFile(archive, contents, 0600); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(contents)
	digest := hex.EncodeToString(hash[:])
	state, _ := defaultState("1.0.0")
	state.AvailableVersion = "1.1.0"
	state.DownloadedPath = archive
	state.DownloadedSHA256 = digest
	state.Target = &updateTarget{Kind: "archive", Size: int64(len(contents)), SHA256: digest}
	update := updater{store: store, now: time.Now}
	if err := update.applyNative(ctx, &state); err == nil {
		t.Fatal("cancelled readiness must fail")
	}
	if !began.Load() || !resumed.Load() {
		t.Fatalf("drain cleanup missing: begin=%v resume=%v", began.Load(), resumed.Load())
	}
	if state.LastErrorCode != "host_not_idle" {
		t.Fatalf("unexpected failure: %#v", state)
	}
}
