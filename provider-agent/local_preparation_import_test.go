package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalPreparationImportVerifiedLocalFileOnly(t *testing.T) {
	for _, mode := range []string{"success", "corrupt", "paused", "stopped", "cancelled", "command-failure", "invalid-context"} {
		t.Run(mode, func(t *testing.T) {
			storage, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			root := filepath.Join(storage, "local-artifacts")
			if err = os.Mkdir(root, 0700); err != nil {
				t.Fatal(err)
			}
			payload := []byte("synthetic GGUF")
			hash := sha256.Sum256(payload)
			artifact := localPreparationArtifact{ModelID: "author/model", Revision: strings.Repeat("a", 40), Filename: "model.gguf", SHA256: hex.EncodeToString(hash[:]), Bytes: uint64(len(payload))}
			original := filepath.Join(root, artifact.SHA256+".gguf")
			if mode == "corrupt" {
				payload[0] = 'x'
			}
			if err = os.WriteFile(original, payload, 0600); err != nil {
				t.Fatal(err)
			}
			commands := &managedOllamaTestCommands{}
			manager := newManagedOllamaTestManager(t, managedOllamaConfig{Commands: commands})
			installManagedOllamaTestRuntime(t, manager, strings.Repeat("a", 64))
			if mode != "stopped" {
				manager.process = newManagedOllamaTestProcess(true)
			}
			policy := managedOllamaTestPolicy(storage, 1, mode == "paused", true)
			commands.run = func(ctx context.Context, binary string, args, env []string, dir string, limit int64) ([]byte, error) {
				if len(args) != 4 || args[0] != "create" || !strings.HasPrefix(args[1], "multivibe-local-") || args[2] != "-f" {
					t.Fatalf("unexpected command: %v", args)
				}
				contents, err := os.ReadFile(args[3])
				if err != nil {
					t.Fatal(err)
				}
				if string(contents) != "FROM ./model.gguf\nPARAMETER num_ctx 2048\n" {
					t.Fatalf("unsafe Modelfile: %s", contents)
				}
				data, err := os.ReadFile(filepath.Join(dir, "model.gguf"))
				if err != nil || string(data) != string(payload) {
					t.Fatal("wrong import source")
				}
				if mode == "command-failure" {
					return nil, errors.New("private runtime diagnostic")
				}
				return []byte("success"), nil
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if mode == "cancelled" {
				cancel()
			}
			tokens := uint64(2048)
			if mode == "invalid-context" {
				tokens = 0
			}
			model, err := manager.importLocalPreparationArtifact(ctx, policy, artifact, tokens)
			if mode == "success" {
				if err != nil || model == "" {
					t.Fatal(model, err)
				}
			} else {
				if err == nil || model != "" {
					t.Fatal("failure accepted", model, err)
				}
			}
			if mode != "success" && mode != "command-failure" && commands.runCalls != 0 {
				t.Fatal("command before validation")
			}
			files, err := os.ReadDir(root)
			if err != nil || len(files) != 1 {
				t.Fatal("staging not cleaned", files, err)
			}
			after, err := os.ReadFile(original)
			if err != nil || string(after) != string(payload) {
				t.Fatal("original modified")
			}
		})
	}
}
