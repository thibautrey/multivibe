package main

import (
	"context"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type preparationDownloadTestRuntime struct {
	*managedControllerTestRuntime
	catalog providerModelCatalog
	pull    func(context.Context, managedModelDownloadProgress) error
}

func (r *preparationDownloadTestRuntime) localPreparationCatalog() providerModelCatalog {
	return cloneRuntimeBackendCatalog(r.catalog)
}
func (r *preparationDownloadTestRuntime) pullModelResultProgress(ctx context.Context, _ *capacityPolicyStateDocument, _ string, d plannedModelDownload, progress managedModelDownloadProgress) (managedOllamaModelRecord, bool, error) {
	r.record("stream-pull")
	if err := r.pull(ctx, progress); err != nil {
		return managedOllamaModelRecord{}, false, err
	}
	entry, _ := r.catalog.entry(d.ModelID)
	return managedOllamaModelRecord{CanonicalModelID: entry.CanonicalModelID, OllamaModel: entry.OllamaModel, OllamaManifestPath: entry.OllamaManifestPath, ManifestSHA256: strings.TrimPrefix(entry.ContentDigest, "sha256:")}, true, nil
}
func preparationDownloadFixture(t *testing.T) (managedControllerFixture, *preparationDownloadTestRuntime, plannedModelDownload, string) {
	t.Helper()
	f := localPreparationFixture(t)
	storage, err := filepath.EvalSymlinks(f.base)
	if err != nil {
		t.Fatal(err)
	}
	storage = filepath.Join(storage, "models")
	if err := os.MkdirAll(storage, 0700); err != nil {
		t.Fatal(err)
	}
	p := f.policy.snapshot()
	p.Policy.ModelStoragePath = storage
	if _, conflict, err := f.policy.replace(p.Revision, *p); err != nil || conflict {
		t.Fatal(err)
	}
	catalog, err := openProviderModelCatalog(f.controller.catalogPath)
	if err != nil {
		t.Fatal(err)
	}
	r := &preparationDownloadTestRuntime{managedControllerTestRuntime: f.runtime, catalog: catalog}
	r.installed = true
	r.running = true
	r.pull = func(ctx context.Context, progress managedModelDownloadProgress) error {
		return progress(1, catalog.Models[0].DownloadBytes)
	}
	f.controller.runtime = r
	entry := catalog.Models[0]
	return f, r, plannedModelDownload{ModelID: entry.CanonicalModelID, Bytes: entry.DownloadBytes}, entry.ContentDigest
}
func TestLocalPreparationDownloadReservesBeforePullAndRetainsFailedBudget(t *testing.T) {
	f, r, d, digest := preparationDownloadFixture(t)
	p := f.policy.snapshot()
	p.Policy.MaxDownloadBytesPerDay = &d.Bytes
	if _, conflict, err := f.policy.replace(p.Revision, *p); err != nil || conflict {
		t.Fatal(err)
	}
	p = f.policy.snapshot()
	r.pull = func(_ context.Context, _ managedModelDownloadProgress) error {
		reopened, err := openManagedPlannerStateStore(f.plannerState.path)
		if err != nil {
			t.Fatal(err)
		}
		state, err := reopened.plannerState(nil)
		if err != nil {
			t.Fatal(err)
		}
		usage, err := recentDownloadUsage(state.Downloads, f.now)
		if err != nil || usage != d.Bytes {
			t.Fatal("reservation not durable before network", usage, err)
		}
		return errors.New("network interrupted")
	}
	callback := func(uint64, uint64) error { return nil }
	if _, err := f.controller.downloadLocalPreparationModel(context.Background(), p, d, digest, callback); err == nil {
		t.Fatal("failure ignored")
	}
	if _, err := f.controller.downloadLocalPreparationModel(context.Background(), p, d, digest, callback); !errors.Is(err, errLocalPreparationDownloadBudget) {
		t.Fatal(err)
	}
	if len(r.calls) != 1 {
		t.Fatal("retried beyond budget", r.calls)
	}
	if *f.policy.snapshot().AllowCloudWorkloads {
		t.Fatal("Cloud enabled")
	}
}
func TestLocalPreparationDownloadRejectsBeforeNetwork(t *testing.T) {
	for _, mode := range []string{"digest", "volume", "disk", "reserve", "storage", "accounting", "paused", "cancelled", "runtime"} {
		t.Run(mode, func(t *testing.T) {
			f, r, d, digest := preparationDownloadFixture(t)
			p := f.policy.snapshot()
			switch mode {
			case "digest":
				digest = "sha256:" + strings.Repeat("0", 64)
			case "volume":
				d.Bytes++
			case "disk":
				v := d.Bytes - 1
				p.Policy.MaxDiskBytes = &v
			case "reserve":
				v := uint64(math.MaxUint64)
				p.Policy.ReserveFreeDiskBytes = &v
			case "storage":
				p.Policy.ModelStoragePath = filepath.Join(p.Policy.ModelStoragePath, "missing")
			case "accounting":
				f.plannerState.path = ""
			case "paused":
				p.Paused = managedOllamaTestBool(true)
			case "runtime":
				r.running = false
			}
			if _, conflict, err := f.policy.replace(p.Revision, *p); err != nil || conflict {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if mode == "cancelled" {
				cancel()
			}
			if _, err := f.controller.downloadLocalPreparationModel(ctx, f.policy.snapshot(), d, digest, func(uint64, uint64) error { return nil }); err == nil {
				t.Fatal("invalid pull accepted")
			}
			if len(r.calls) != 0 {
				t.Fatal("network started", r.calls)
			}
		})
	}
}
func TestLocalPreparationDownloadSuccessAndRevocation(t *testing.T) {
	for _, revoke := range []bool{false, true} {
		f, r, d, digest := preparationDownloadFixture(t)
		r.pull = func(ctx context.Context, progress managedModelDownloadProgress) error {
			if revoke {
				p := f.policy.snapshot()
				p.Paused = managedOllamaTestBool(true)
				if _, conflict, err := f.policy.replace(p.Revision, *p); err != nil || conflict {
					t.Fatal(err)
				}
			}
			return progress(1, d.Bytes)
		}
		updates := 0
		record, err := f.controller.downloadLocalPreparationModel(context.Background(), f.policy.snapshot(), d, digest, func(completed, total uint64) error { updates++; return nil })
		if revoke {
			if err == nil || record.CanonicalModelID != "" {
				t.Fatal("revoked result exposed")
			}
		} else if err != nil || record.CanonicalModelID != d.ModelID || updates != 1 {
			t.Fatal(record, err, updates)
		}
	}
}
func TestLocalPreparationStorageIncludesPartialFilesAndRejectsLinks(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "partial"), []byte("12345"), 0600); err != nil {
		t.Fatal(err)
	}
	if n, err := localPreparationStorageBytes(context.Background(), root); err != nil || n != 5 {
		t.Fatal(n, err)
	}
	if err := os.Symlink(filepath.Join(root, "partial"), filepath.Join(root, "link")); err != nil {
		t.Skip(err)
	}
	if _, err := localPreparationStorageBytes(context.Background(), root); err == nil {
		t.Fatal("symlink accepted")
	}
}
func TestLocalPreparationBudgetReservationIsAtomic(t *testing.T) {
	f, _, d, _ := preparationDownloadFixture(t)
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); results <- f.plannerState.reserveDownload(d, f.now, d.Bytes) }()
	}
	wg.Wait()
	close(results)
	accepted := 0
	for err := range results {
		if err == nil {
			accepted++
		} else if !errors.Is(err, errLocalPreparationDownloadBudget) {
			t.Fatal(err)
		}
	}
	if accepted != 1 {
		t.Fatal(accepted)
	}
}
