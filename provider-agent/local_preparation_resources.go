package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// A point-in-time observation, not permission or a promise that a model fits.
// Missing measurements are explicit nulls; no total-memory fallback is allowed.
type localPreparationResources struct {
	ObservedAt                 string  `json:"observed_at"`
	PolicyRevision             uint64  `json:"policy_revision"`
	FreeHostMemoryBytes        *uint64 `json:"free_host_memory_bytes"`
	FreeAcceleratorMemoryBytes *uint64 `json:"free_accelerator_memory_bytes"`
	FreeStorageBytes           *uint64 `json:"free_storage_bytes"`
	OccupiedStorageBytes       *uint64 `json:"occupied_storage_bytes"`
	StorageError               string  `json:"storage_error,omitempty"`
}

var vmPageSize = regexp.MustCompile(`^Mach Virtual Memory Statistics: \(page size of ([0-9]+) bytes\)`)

func parsePreparationMemory(osName string, data []byte) *uint64 {
	if len(data) > 64*1024 {
		return nil
	}
	lines := strings.Split(string(data), "\n")
	key, unit := "MemAvailable:", uint64(1024)
	if osName == "darwin" {
		if len(lines) == 0 {
			return nil
		}
		match := vmPageSize.FindStringSubmatch(lines[0])
		if len(match) != 2 {
			return nil
		}
		var err error
		unit, err = strconv.ParseUint(match[1], 10, 64)
		if err != nil || (unit != 4096 && unit != 16384) {
			return nil
		}
		// Only free pages: inactive/compressed pages are not guaranteed reclaimable.
		key = "Pages free:"
	} else if osName != "linux" {
		return nil
	}
	var result *uint64
	for _, line := range lines {
		if !strings.HasPrefix(line, key) {
			continue
		}
		if result != nil {
			return nil
		}
		fields := strings.Fields(strings.TrimPrefix(line, key))
		if len(fields) == 0 {
			return nil
		}
		if osName == "linux" && (len(fields) != 2 || fields[1] != "kB") {
			return nil
		}
		if osName == "darwin" && len(fields) != 1 {
			return nil
		}
		value, err := strconv.ParseUint(strings.TrimSuffix(fields[0], "."), 10, 64)
		if err != nil {
			return nil
		}
		bytes, ok := checkedMultiply(value, unit)
		if !ok {
			return nil
		}
		result = &bytes
	}
	return result
}

func preparationMemory(ctx context.Context, capability hostCapability) (*uint64, *uint64) {
	var host *uint64
	if capability.OS == "darwin" {
		if data, err := fixedPlatformCommand(ctx, "vm_stat"); err == nil {
			host = parsePreparationMemory("darwin", data)
		}
	} else if capability.OS == "linux" {
		if data, err := os.ReadFile("/proc/meminfo"); err == nil {
			host = parsePreparationMemory("linux", data)
		}
	}
	if capability.Accelerator == "metal" {
		return host, host
	}
	if capability.Accelerator == "cuda" && int(capability.CUDADevice) < len(capability.GPUs) {
		gpu := capability.GPUs[capability.CUDADevice]
		if gpu.UUID != "" {
			data, err := fixedPlatformCommand(ctx, "nvidia-smi", "--id="+gpu.UUID, "--query-gpu=memory.free", "--format=csv,noheader,nounits")
			if err == nil && len(data) < 64 {
				mib, err := strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64)
				bytes, ok := checkedMultiply(mib, 1<<20)
				if err == nil && ok && mib <= gpu.MemoryMiB {
					return host, &bytes
				}
			}
		}
	}
	return host, nil
}

func observePreparationResources(ctx context.Context, document *capacityPolicyStateDocument, memory, accelerator *uint64) localPreparationResources {
	result := localPreparationResources{ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), FreeHostMemoryBytes: memory, FreeAcceleratorMemoryBytes: accelerator}
	if document == nil {
		result.StorageError = "host_policy_required"
		return result
	}
	result.PolicyRevision = document.Revision
	policy, err := validateCapacityPolicy(document.Policy)
	if err != nil {
		result.StorageError = "host_policy_required"
		return result
	}
	occupied, err := localPreparationStorageBytes(ctx, policy.modelStoragePath)
	if err != nil {
		result.StorageError = "storage_unavailable"
		return result
	}
	free, err := providerFreeDiskBytes(policy.modelStoragePath)
	if err != nil {
		result.StorageError = "storage_unavailable"
		return result
	}
	result.OccupiedStorageBytes = &occupied
	result.FreeStorageBytes = &free
	return result
}

func localPreparationResourcesHandler(store *capacityPolicyStore, capability hostCapability, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !authorizeProviderControl(r, token) {
			http.Error(w, "not found", 404)
			return
		}
		w.Header().Set("cache-control", "no-store")
		w.Header().Set("content-type", "application/json")
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		var document *capacityPolicyStateDocument
		if store != nil {
			document = store.snapshot()
		}
		memory, accelerator := preparationMemory(ctx, capability)
		result := observePreparationResources(ctx, document, memory, accelerator)
		// Do not let observations from one policy be reused against another.
		if store != nil {
			current := store.snapshot()
			if current == nil || document == nil || current.Revision != document.Revision {
				w.WriteHeader(http.StatusConflict)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": "new_preflight_required"})
				return
			}
		}
		_ = json.NewEncoder(w).Encode(result)
	}
}
