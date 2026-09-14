package main

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func localPreparationFixture(t *testing.T) managedControllerFixture {
	t.Helper()
	f := newManagedControllerFixture(t)
	persistWorkerTestPolicyAndCatalog(t, &f, true)
	p := f.policy.snapshot()
	p.AllowCloudWorkloads = managedOllamaTestBool(false)
	if _, conflict, err := f.policy.replace(p.Revision, *p); err != nil || conflict {
		t.Fatal("policy setup failed", err)
	}
	return f
}

func TestLocalPreparationDoesNotRequireOrGrantCloudConsent(t *testing.T) {
	f := localPreparationFixture(t)
	policy := f.policy.snapshot()
	if err := f.controller.installLocalPreparationRuntime(context.Background(), policy); err != nil {
		t.Fatal(err)
	}
	if err := f.controller.startLocalPreparationRuntime(context.Background(), policy); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(policy, f.policy.snapshot()) {
		t.Fatal("policy was mutated")
	}
	if !reflect.DeepEqual(f.runtime.calls, []string{"install", "start"}) {
		t.Fatal(f.runtime.calls)
	}
	if _, err := f.controller.install(context.Background(), policy.Revision); !errors.Is(err, errManagedControllerConsent) {
		t.Fatal("Cloud operation authorized", err)
	}
	view := f.controller.status()
	if view.CustomerTrafficAllowed || view.RoutingEligible {
		t.Fatal("Cloud routing granted")
	}
}

func TestLocalPreparationPolicyFencesBeforeSideEffects(t *testing.T) {
	for _, mode := range []string{"paused", "downloads-disabled", "changed-document", "memory-only", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			f := localPreparationFixture(t)
			p := f.policy.snapshot()
			if mode == "paused" || mode == "downloads-disabled" {
				if mode == "paused" {
					p.Paused = managedOllamaTestBool(true)
				} else {
					p.AutomaticDownloads = managedOllamaTestBool(false)
				}
				if _, conflict, err := f.policy.replace(p.Revision, *p); err != nil || conflict {
					t.Fatal(err)
				}
				p = f.policy.snapshot()
			}
			if mode == "changed-document" {
				p.Policy.ModelStoragePath += "/changed"
			}
			if mode == "memory-only" {
				f.policy.path = ""
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if mode == "cancelled" {
				cancel()
			}
			if err := f.controller.installLocalPreparationRuntime(ctx, p); err == nil {
				t.Fatal("invalid operation accepted")
			}
			if len(f.runtime.calls) != 0 {
				t.Fatal("side effects", f.runtime.calls)
			}
		})
	}
}

func TestLocalPreparationRejectsRevocationDuringBackendOperation(t *testing.T) {
	f := localPreparationFixture(t)
	p := f.policy.snapshot()
	err := f.controller.withLocalPreparationRuntime(context.Background(), p, true, "local-test", func(ctx context.Context, _ *capacityPolicyStateDocument) error {
		next := f.policy.snapshot()
		next.Paused = managedOllamaTestBool(true)
		if _, conflict, err := f.policy.replace(next.Revision, *next); err != nil || conflict {
			t.Fatal(err)
		}
		return nil // Simulate a backend ignoring cancellation.
	})
	if err == nil {
		t.Fatal("revoked operation reported success")
	}
}
