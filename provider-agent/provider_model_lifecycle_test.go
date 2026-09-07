package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"testing"
	"time"
)

func verifyLifecycleInventorySignature(t *testing.T, identity *deviceIdentity, envelope signedProviderModelInventory) {
	t.Helper()
	canonical, err := canonicalJSON(map[string]any{
		"envelopeVersion": envelope.EnvelopeVersion,
		"kind":            envelope.Kind,
		"payload":         providerModelInventoryPayloadMap(envelope.Payload),
		"signature": map[string]any{
			"algorithm": envelope.Signature.Algorithm,
			"keyId":     envelope.Signature.KeyID,
		},
	}, providerModelInventoryMaximumBytes)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := base64.RawURLEncoding.DecodeString(envelope.Signature.Value)
	if err != nil || !ed25519.Verify(
		identity.privateKey.Public().(ed25519.PublicKey),
		append([]byte(providerModelInventorySigningDomain), canonical...),
		signature,
	) {
		t.Fatal("provider model inventory signature is invalid")
	}
}

func lifecycleEnrollment(t *testing.T, identity *deviceIdentity) cloudEnrollmentView {
	t.Helper()
	keyID, _ := identity.publicIdentity()
	return cloudEnrollmentView{
		ProviderID: testProviderID, NodeID: testNodeID, DeviceKeyID: keyID,
		CredentialEpoch: 1, ManifestDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RuntimeFamily: "omlx", DeclaredMaxConcurrency: 8,
	}
}

func TestProviderModelLifecyclePublishesNoLocalRuntimeInventory(t *testing.T) {
	identity, err := newMemoryDeviceIdentity()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 7, 18, 0, 0, 0, time.UTC)
	service := &providerModelLifecycleService{identity: identity, now: func() time.Time { return now }}
	policy := managedOllamaTestPolicy(t.TempDir(), 1, false, true)
	policy.AllowCloudWorkloads = managedOllamaTestBool(true)

	envelope, err := service.signInventory(lifecycleEnrollment(t, identity), policy)
	if err != nil {
		t.Fatal(err)
	}
	if len(envelope.Payload.Runtimes) != 0 || len(envelope.Payload.Diagnostics) != 0 {
		t.Fatalf("local runtime state crossed the Cloud boundary: %#v", envelope.Payload)
	}
	if envelope.Payload.MaxConcurrency != 1 || envelope.Payload.AvailableConcurrency != 0 {
		t.Fatalf("legacy enrollment capacity crossed the Cloud boundary: %#v", envelope.Payload)
	}
	verifyLifecycleInventorySignature(t, identity, envelope)
}

func TestProviderModelLifecycleAdvertisesOnlyConsentedManagedOllama(t *testing.T) {
	fixture := newManagedControllerFixture(t)
	const modelID = "hf:qwen/qwen2.5-0.5b-instruct"
	fixture.runtime.inventory = []string{modelID}
	catalog, err := openProviderModelCatalog(fixture.controller.catalogPath)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := newMemoryDeviceIdentity()
	if err != nil {
		t.Fatal(err)
	}
	service := &providerModelLifecycleService{
		identity: identity, controller: fixture.controller, demand: &providerDemandService{catalog: catalog},
		now: func() time.Time { return fixture.now },
	}
	policy := fixture.policy.snapshot()
	runtimes := service.inventoryRuntimes(policy)
	if len(runtimes) != 1 || runtimes[0].RuntimeFamily != managedWorkerAdapterID || len(runtimes[0].Models) != 1 ||
		runtimes[0].Models[0].ReportedID != modelID || !runtimes[0].Models[0].ArtifactVerified ||
		runtimes[0].Models[0].ContentDigest == nil {
		t.Fatalf("managed runtime inventory is invalid: %#v", runtimes)
	}
	envelope, err := service.signInventory(lifecycleEnrollment(t, identity), policy)
	if err != nil {
		t.Fatal(err)
	}
	if envelope.Payload.AvailableConcurrency != 1 {
		t.Fatalf("consented managed capacity was not advertised: %#v", envelope.Payload)
	}
	verifyLifecycleInventorySignature(t, identity, envelope)

	disabled := cloneCapacityPolicyState(*policy)
	disabled.AllowCloudWorkloads = managedOllamaTestBool(false)
	disabledEnvelope, err := service.signInventory(lifecycleEnrollment(t, identity), disabled)
	if err != nil {
		t.Fatal(err)
	}
	if len(disabledEnvelope.Payload.Runtimes) != 0 || disabledEnvelope.Payload.AvailableConcurrency != 0 {
		t.Fatalf("managed capacity was advertised without consent: %#v", disabledEnvelope.Payload)
	}
}
