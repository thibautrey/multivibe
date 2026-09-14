package main

import (
	"archive/tar"
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestRuntimeSpaceReadOnly(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	absent := filepath.Join(root, "absent", "runtime")
	if preparationRuntimeFreeBytes(absent) == nil {
		t.Fatal("missing ancestor measurement")
	}
	if _, err := os.Stat(filepath.Dir(absent)); !os.IsNotExist(err) {
		t.Fatal("created directory")
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(root, link); err == nil {
		if preparationRuntimeFreeBytes(filepath.Join(link, "absent")) != nil {
			t.Fatal("followed symlink ancestor")
		}
	}
	if preparationRuntimeFreeBytes("relative") != nil {
		t.Fatal("relative root")
	}
}
func TestRuntimeTarExpansionCheckedBeforeExtraction(t *testing.T) {
	var buffer bytes.Buffer
	writer := tar.NewWriter(&buffer)
	if err := writer.WriteHeader(&tar.Header{Name: "oversized", Mode: 0600, Size: managedOllamaArchiveMaxBytes + 1}); err != nil {
		t.Fatal(err)
	}
	if err := validateManagedOllamaTarSize(context.Background(), bytes.NewReader(buffer.Bytes())); err == nil {
		t.Fatal("accepted oversized header")
	}
	buffer.Reset()
	writer = tar.NewWriter(&buffer)
	_ = writer.WriteHeader(&tar.Header{Name: "small", Mode: 0600, Size: 2})
	_, _ = writer.Write([]byte("OK"))
	_ = writer.Close()
	if err := validateManagedOllamaTarSize(context.Background(), bytes.NewReader(buffer.Bytes())); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := validateManagedOllamaTarSize(ctx, bytes.NewReader(buffer.Bytes())); err == nil {
		t.Fatal("ignored cancellation")
	}
}
