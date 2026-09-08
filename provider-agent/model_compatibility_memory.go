//go:build !windows

package main

func compatibilityHostMemory(host hostCapability) uint64 {
	if host.OS == "linux" {
		return detectLinuxCPUCapability(host.Architecture, readCPUProbe).AcceleratorMemoryBytes / (1 << 20)
	}
	return 0 // Metal uses the existing shared-memory capability budget.
}
