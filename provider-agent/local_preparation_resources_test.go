package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestPreparationMemoryMeasurements(t *testing.T) {
	for _, tc := range []struct {
		name, platform, input string
		want                  *uint64
	}{
		{"linux available not total", "linux", "MemTotal: 999999 kB\nMemAvailable: 123 kB\n", preparationBytesPointer(123 * 1024)},
		{"mac free not inactive", "darwin", "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 42.\nPages inactive: 99999.\n", preparationBytesPointer(42 * 16384)},
		{"zero is measured", "linux", "MemAvailable: 0 kB", preparationBytesPointer(0)},
		{"missing", "linux", "MemTotal: 100 kB", nil},
		{"bad units", "linux", "MemAvailable: 100 MB", nil},
		{"duplicate", "linux", "MemAvailable: 1 kB\nMemAvailable: 2 kB", nil},
		{"overflow", "linux", "MemAvailable: 18446744073709551615 kB", nil},
		{"invalid page", "darwin", "Mach Virtual Memory Statistics: (page size of 1 bytes)\nPages free: 42.", nil},
		{"unknown OS", "unknown", "MemAvailable: 100 kB", nil},
		{"too long", "linux", strings.Repeat("x", 65537), nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := parsePreparationMemory(tc.platform, []byte(tc.input)); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

func TestPreparationResourcesReadOnlyAndStorageAccounting(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "partial.gguf"), []byte("partial"), 0600); err != nil {
		t.Fatal(err)
	}
	policy := testCapacityPolicyState()
	policy.Revision = 7
	policy.Paused = explicitBool(true)
	policy.Policy.ModelStoragePath = root
	before, _ := json.Marshal(policy)
	result := observePreparationResources(context.Background(), &policy, preparationBytesPointer(123), nil)
	if result.StorageError != "" || result.FreeStorageBytes == nil || result.OccupiedStorageBytes == nil || *result.OccupiedStorageBytes != 7 || result.PolicyRevision != 7 {
		t.Fatalf("%+v", result)
	}
	after, _ := json.Marshal(policy)
	if string(before) != string(after) {
		t.Fatal("observation changed policy")
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 1 {
		t.Fatal("observation changed files")
	}
	policy.Policy.ModelStoragePath = filepath.Join(root, "absent")
	result = observePreparationResources(context.Background(), &policy, nil, nil)
	if result.StorageError != "storage_unavailable" || result.FreeStorageBytes != nil || result.FreeHostMemoryBytes != nil {
		t.Fatalf("%+v", result)
	}
	if _, err = os.Stat(policy.Policy.ModelStoragePath); !os.IsNotExist(err) {
		t.Fatal("created storage without consent")
	}
	if err = os.Symlink(root, filepath.Join(root, "link")); err == nil {
		policy.Policy.ModelStoragePath = root
		if observePreparationResources(context.Background(), &policy, nil, nil).StorageError != "storage_unavailable" {
			t.Fatal("accepted symlink in storage")
		}
	}
}

func TestPreparationResourcesPrivateAndUnknownIsExplicit(t *testing.T) {
	token := strings.Repeat("a", 32)
	handler := localPreparationResourcesHandler(nil, hostCapability{}, token)
	for _, authorized := range []bool{false, true} {
		request := httptest.NewRequest("GET", "/v1/local-preparation/resources", nil)
		if authorized {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		result := httptest.NewRecorder()
		handler(result, request)
		if !authorized {
			if result.Code != 404 {
				t.Fatal(result.Code)
			}
			continue
		}
		if result.Code != 200 || result.Header().Get("cache-control") != "no-store" {
			t.Fatal(result.Code)
		}
		var data map[string]any
		if err := json.Unmarshal(result.Body.Bytes(), &data); err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"free_host_memory_bytes", "free_accelerator_memory_bytes", "free_storage_bytes", "occupied_storage_bytes"} {
			value, exists := data[key]
			if !exists || value != nil {
				t.Fatal("unknown was not explicit", key, value)
			}
		}
	}
}

func preparationBytesPointer(value uint64) *uint64 { return &value }
