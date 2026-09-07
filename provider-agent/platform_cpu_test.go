package main

import (
	"os"
	"strings"
	"testing"
)

func TestLinuxCPUCapacity(t *testing.T) {
	for _, test := range []struct {
		name, groupLimit, parentLimit string
		supported                     bool
		memory                        uint64
	}{
		{"physical", "max", "max", true, 8 << 30},
		{"container", "8589934592", "max", true, 4 << 30},
		{"ancestor", "max", "4294967296", true, 2 << 30},
		{"too small", "2147483648", "max", false, 0},
		{"invalid", "unlimited", "max", false, 0},
		{"oversized", strings.Repeat("1", 33), "max", false, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			files := map[string]string{"/proc/meminfo": "MemTotal: 16777216 kB\n", "/proc/self/cgroup": "0::/parent/child\n", "/sys/fs/cgroup/parent/child/memory.max": test.groupLimit, "/sys/fs/cgroup/parent/memory.max": test.parentLimit, "/sys/fs/cgroup/cgroup.controllers": "memory cpu"}
			read := func(name string) ([]byte, error) {
				value, ok := files[name]
				if !ok {
					return nil, os.ErrNotExist
				}
				return []byte(value), nil
			}
			for _, arch := range []string{"amd64", "arm64"} {
				got := detectLinuxCPUCapability(arch, read)
				if got.Supported != test.supported || got.AcceleratorMemoryBytes != test.memory {
					t.Fatalf("%s: %+v", arch, got)
				}
				if got.Supported {
					if _, err := providerAcceleratorMemoryCapacity(got); err != nil {
						t.Fatal(err)
					}
				}
			}
		})
	}
}

func TestLinuxCPURejectsMissingMemoryProbe(t *testing.T) {
	got := detectLinuxCPUCapability("arm64", func(string) ([]byte, error) { return nil, os.ErrPermission })
	if got.Supported {
		t.Fatal("missing memory probes must fail closed")
	}
}

func TestCPUEnvironmentDisablesGPUDiscovery(t *testing.T) {
	manager := &managedOllama{goos: "linux", cpuOnly: true, root: "/tmp/runtime", listenAddress: "127.0.0.1:11434"}
	env := strings.Join(manager.commandEnvironment("/models"), "\n")
	for _, expected := range []string{"CUDA_VISIBLE_DEVICES=-1", "ROCR_VISIBLE_DEVICES=-1", "GGML_VK_VISIBLE_DEVICES=-1", "OLLAMA_VULKAN=false", "OLLAMA_NUM_PARALLEL=1"} {
		if !strings.Contains(env, expected) {
			t.Fatalf("missing %s", expected)
		}
	}
}
