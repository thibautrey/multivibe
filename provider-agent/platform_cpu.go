package main

import (
	"errors"
	"io"
	"os"
	"path"
	"strconv"
	"strings"
)

// Only fixed procfs/cgroup files are read. A failed or unsupported memory
// probe disables CPU hosting instead of advertising the entire machine's RAM.
func readCPUProbe(name string) ([]byte, error) {
	f, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 65537))
	if len(data) > 65536 {
		return nil, errors.New("CPU memory probe exceeds limit")
	}
	return data, err
}

func detectLinuxCPUCapability(architecture string, read func(string) ([]byte, error)) hostCapability {
	result := hostCapability{SchemaVersion: "multivibe-host-capability-v1", AgentVersion: providerAgentVersion, OS: "linux", Architecture: architecture, Reason: "Linux CPU hosting requires amd64/arm64, cgroup v2 and at least 4 GiB of available memory capacity"}
	if architecture != "amd64" && architecture != "arm64" {
		return result
	}
	data, err := read("/proc/meminfo")
	if err != nil || len(data) > 65536 {
		return result
	}
	var total uint64
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 3 && fields[0] == "MemTotal:" && fields[2] == "kB" {
			value, parseErr := strconv.ParseUint(fields[1], 10, 64)
			if parseErr != nil || value > maximumDarwinUnifiedMemoryBytes/1024 || total != 0 {
				return result
			}
			total = value * 1024
		}
	}
	data, err = read("/proc/self/cgroup")
	if err != nil || len(data) > 65536 {
		return result
	}
	record := strings.TrimSpace(string(data))
	if !strings.HasPrefix(record, "0::/") || strings.Contains(record, "\n") {
		return result
	}
	group := strings.TrimPrefix(record, "0::")
	if path.Clean(group) != group {
		return result
	}
	// Include ancestor limits on native hosts. In a private container cgroup
	// namespace, / is the container's root and memory.max carries its limit.
	for {
		filename := "/sys/fs/cgroup" + strings.TrimSuffix(group, "/") + "/memory.max"
		limit, readErr := read(filename)
		if readErr != nil {
			// The real cgroup v2 hierarchy root has no memory.max file.
			if group != "/" || !errors.Is(readErr, os.ErrNotExist) {
				return result
			}
			if _, err := read("/sys/fs/cgroup/cgroup.controllers"); err != nil {
				return result
			}
		} else {
			value := strings.TrimSpace(string(limit))
			if len(limit) > 32 {
				return result
			}
			if value != "max" {
				n, parseErr := strconv.ParseUint(value, 10, 64)
				if parseErr != nil || strconv.FormatUint(n, 10) != value {
					return result
				}
				if n < total {
					total = n
				}
			}
		}
		if group == "/" {
			break
		}
		group = path.Dir(group)
	}
	if total < minimumDarwinUnifiedMemoryBytes || total > maximumDarwinUnifiedMemoryBytes {
		return result
	}
	result.Supported, result.Profile, result.Accelerator, result.Reason = true, "linux-cpu", "cpu", ""
	// Reserve half the effective physical/cgroup capacity for Umbrel and other
	// apps. The operator's capacity percentage applies to the remaining half.
	result.AcceleratorMemoryBytes = total / 2
	return result
}
