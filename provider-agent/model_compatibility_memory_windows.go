package main

import (
	"syscall"
	"unsafe"
)

// MEMORYSTATUSEX is filled by Windows, without invoking a shell or a model.
func compatibilityHostMemory(_ hostCapability) uint64 {
	var status struct {
		Length, Load                                                       uint32
		TotalPhysical, AvailablePhysical, TotalPageFile, AvailablePageFile uint64
		TotalVirtual, AvailableVirtual, AvailableExtendedVirtual           uint64
	}
	status.Length = uint32(unsafe.Sizeof(status))
	procedure := syscall.NewLazyDLL("kernel32.dll").NewProc("GlobalMemoryStatusEx")
	if err := procedure.Find(); err != nil {
		return 0
	}
	ok, _, _ := procedure.Call(uintptr(unsafe.Pointer(&status)))
	if ok == 0 {
		return 0
	}
	return min(status.TotalPhysical/2, status.AvailablePhysical) / (1 << 20)
}
