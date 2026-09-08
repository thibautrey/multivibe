//go:build !darwin

package main

func ensureScheduler() error          { return nil }
func wakeScheduler() error            { return nil }
func installedMacApplication() string { return "" }
