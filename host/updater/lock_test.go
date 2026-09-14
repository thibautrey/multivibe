package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestUpdaterLockProcess(t *testing.T) {
	if directory := os.Getenv("MULTIVIBE_TEST_LOCK_DIRECTORY"); directory != "" {
		store := stateStore{directory: directory}
		if _, err := store.lock(); err != nil {
			os.Exit(2)
		}
		if err := os.WriteFile(filepath.Join(directory, "ready"), []byte("ready"), 0600); err != nil {
			os.Exit(3)
		}
		for {
			time.Sleep(time.Second)
		}
	}
	store := testStore(t)
	child := exec.Command(os.Args[0], "-test.run=^TestUpdaterLockProcess$")
	child.Env = append(os.Environ(), "MULTIVIBE_TEST_LOCK_DIRECTORY="+store.directory)
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(store.directory, "ready")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("child failed to acquire lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if release, err := store.lock(); err == nil {
		release()
		t.Fatal("live owner lost mutual exclusion")
	}
	if err := child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = child.Wait()
	release, err := store.lock()
	if err != nil {
		t.Fatalf("crashed owner prevented immediate recovery: %v", err)
	}
	defer release()
	if second, err := store.lock(); err == nil {
		second()
		t.Fatal("recovered lock does not exclude contenders")
	}
}

func TestUpdaterPreservesRecentLegacyLock(t *testing.T) {
	store := testStore(t)
	if err := os.WriteFile(filepath.Join(store.directory, "host-update.lock"), []byte("123\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if release, err := store.lock(); err == nil {
		release()
		t.Fatal("legacy lock was stolen")
	}
}
