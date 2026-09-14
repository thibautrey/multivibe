package main

import (
	"os"
	"syscall"
	"unsafe"
)

var updaterLockFileEx = syscall.NewLazyDLL("kernel32.dll").NewProc("LockFileEx")

func lockUpdaterFile(file *os.File) error {
	var overlapped syscall.Overlapped
	result, _, err := updaterLockFileEx.Call(file.Fd(), 3, 0, 1, 0, uintptr(unsafe.Pointer(&overlapped)))
	if result == 0 {
		return err
	}
	return nil
}
