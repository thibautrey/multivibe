package main

import (
	"context"
	"reflect"
	"time"
)

// Local preparation must not grant Cloud workload consent or mutate signed-plan
// admission. These operations are internal: the preparation service must first
// obtain an exact artifact/volume consent. No public install endpoint uses them.
func localPreparationPolicyConsented(policy *capacityPolicyStateDocument, download bool) bool {
	return policy != nil && validateCapacityPolicyState(*policy) == nil && !*policy.Paused &&
		(!download || (policy.AutomaticDownloads != nil && *policy.AutomaticDownloads))
}

// withLocalPreparationRuntime shares the lifecycle lock and cancellation fence
// with the existing manager. It never adopts or rewrites external runtimes.
func (controller *managedProviderController) withLocalPreparationRuntime(ctx context.Context, expected *capacityPolicyStateDocument, download bool, operation string, run func(context.Context, *capacityPolicyStateDocument) error) error {
	controller.operationMu.Lock()
	defer controller.operationMu.Unlock()
	policy, changed := controller.policy.snapshotWithChange()
	if controller.policy.path == "" || !localPreparationPolicyConsented(policy, download) {
		return errManagedControllerConsent
	}
	if expected == nil || !reflect.DeepEqual(policy, expected) {
		return errManagedControllerFence
	}
	operationContext, cancel := managedControllerChangeContext(ctx, changed, nil, time.Time{})
	controller.beginOperation(operation, cancel, 0, "")
	defer controller.endOperation(cancel)
	if err := operationContext.Err(); err != nil {
		return err
	}
	if err := run(operationContext, policy); err != nil {
		return controller.operationError(operationContext, err)
	}
	// A non-cooperative backend cannot report success after revocation/cancel.
	if err := operationContext.Err(); err != nil {
		return err
	}
	current := controller.policy.snapshot()
	if !reflect.DeepEqual(current, expected) || !localPreparationPolicyConsented(current, download) {
		return errManagedControllerSuperseded
	}
	return nil
}

func (controller *managedProviderController) installLocalPreparationRuntime(ctx context.Context, expected *capacityPolicyStateDocument) error {
	return controller.withLocalPreparationRuntime(ctx, expected, true, "local-install", func(ctx context.Context, policy *capacityPolicyStateDocument) error {
		_, err := controller.runtime.ensureRuntime(ctx, policy, controller.dependencyManifestPath)
		return err
	})
}

func (controller *managedProviderController) startLocalPreparationRuntime(ctx context.Context, expected *capacityPolicyStateDocument) error {
	return controller.withLocalPreparationRuntime(ctx, expected, false, "local-start", func(ctx context.Context, policy *capacityPolicyStateDocument) error {
		_, err := controller.runtime.start(ctx, policy)
		return err
	})
}
