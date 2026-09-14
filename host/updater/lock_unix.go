//go:build darwin || linux

package main

import (
	"os"
	"syscall"
)

func lockUpdaterFile(file *os.File) error {
	return syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
}
