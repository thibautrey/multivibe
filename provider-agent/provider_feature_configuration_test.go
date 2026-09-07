package main

import (
	"strings"
	"testing"
)

func managedProviderFeatureFixture() providerFeatureConfiguration {
	return providerFeatureConfiguration{
		DemandPlanPath:          "/data/provider-agent-demand-plan.json",
		ModelCatalogPath:        "/opt/multivibe/provider-model-catalog.json",
		CapacityPolicyPath:      "/data/provider-agent-capacity-policy.json",
		ManagedRoot:             "/data/provider-agent-managed",
		BundledOllamaRoot:       "/opt/multivibe/runtime/ollama",
		DependencyManifestPath:  "/opt/multivibe/provider-host-dependencies.json",
		ManagedPlannerStatePath: "/data/provider-agent-managed-planner-state.json",
	}
}

func TestManagedProviderFeatureDoesNotRequireDemandTrust(t *testing.T) {
	configuration := managedProviderFeatureFixture()
	if err := validateProviderFeatureConfiguration(configuration); err != nil {
		t.Fatalf("managed runtime without Cloud trust was rejected: %v", err)
	}
	if !configuration.managedRequested() {
		t.Fatal("complete managed runtime configuration was not detected")
	}
	for name, mutate := range map[string]func(*providerFeatureConfiguration){
		"missing-demand-state": func(value *providerFeatureConfiguration) { value.DemandPlanPath = "" },
		"missing-catalog":      func(value *providerFeatureConfiguration) { value.ModelCatalogPath = "" },
		"missing-policy":       func(value *providerFeatureConfiguration) { value.CapacityPolicyPath = "" },
		"missing-root":         func(value *providerFeatureConfiguration) { value.ManagedRoot = "" },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := managedProviderFeatureFixture()
			mutate(&candidate)
			if err := validateProviderFeatureConfiguration(candidate); err == nil ||
				!strings.Contains(err.Error(), "managed Ollama requires") {
				t.Fatalf("incomplete managed configuration was accepted: %v", err)
			}
		})
	}
}

func TestDemandTrustAndOutboundWorkerStayFailClosed(t *testing.T) {
	configuration := providerFeatureConfiguration{TrustedDemandKeys: `{"ed25519:test":"spki"}`}
	if err := validateProviderFeatureConfiguration(configuration); err == nil ||
		!strings.Contains(err.Error(), "provider demand trust requires") {
		t.Fatalf("unbound demand trust was accepted: %v", err)
	}
	backend := &ollamaRuntimeBackend{}
	demand := &providerDemandService{}
	if communityOutboundConfigured(backend, nil) || communityOutboundConfigured(nil, demand) ||
		communityOutboundConfigured(nil, nil) {
		t.Fatal("community outbound work was enabled without both managed runtime and signed demand trust")
	}
	if !communityOutboundConfigured(backend, demand) {
		t.Fatal("complete outbound configuration was not detected")
	}
}
