package main

import (
	"os"
	"path/filepath"
)

// Observe the managed runtime filesystem without creating directories or
// following symlinks. An absent root uses its nearest existing ancestor.
func preparationRuntimeFreeBytes(root string) *uint64 {
	if !filepath.IsAbs(root) || filepath.Clean(root) != root || root == string(filepath.Separator) {
		return nil
	}
	current := root
	for {
		info, err := os.Lstat(current)
		if os.IsNotExist(err) {
			parent := filepath.Dir(current)
			if parent == current {
				return nil
			}
			current = parent
			continue
		}
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		// Check every ancestor too; Lstat alone only checks the final component.
		for parent := filepath.Dir(current); ; parent = filepath.Dir(parent) {
			info, err := os.Lstat(parent)
			if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return nil
			}
			if parent == filepath.Dir(parent) {
				break
			}
		}
		free, err := providerFreeDiskBytes(current)
		if err != nil {
			return nil
		}
		return &free
	}
}
