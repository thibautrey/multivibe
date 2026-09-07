package main

import (
 "os"
 "path/filepath"
 "strings"
 "testing"
)

func TestStaleDigestsAndDependencyMismatch(t *testing.T) {
 root := t.TempDir()
 for _, name := range []string{"packaging/provider-runtime-profiles.json", "packaging/provider-host-dependencies.json", "provider-agent/runtimeprofile/testdata/catalog-v3.golden.json"} {
  raw, err := os.ReadFile(filepath.Join("../../..", name)); if err != nil { t.Fatal(err) }
  dst := filepath.Join(root, name)
  if err := os.MkdirAll(filepath.Dir(dst),0755); err != nil { t.Fatal(err) }
  if err := os.WriteFile(dst,raw,0644); err != nil { t.Fatal(err) }
 }
 if err := run(root,true); err != nil { t.Fatal(err) }
 if err := run(root,false); err != nil { t.Fatal(err) }
 name := filepath.Join(root,"packaging/provider-runtime-profiles.json")
 raw, _ := os.ReadFile(name)
 changed := strings.Replace(string(raw), `"priority": 100`, `"priority": 99`,1)
 if changed == string(raw) { t.Fatal("fixture priority not found") }
 os.WriteFile(name,[]byte(changed),0644)
 if err := run(root,false); err == nil { t.Fatal("accepted stale profile digest") }
 if err := run(root,true); err != nil { t.Fatal(err) }
 if err := run(root,false); err != nil { t.Fatal(err) }
 dep := filepath.Join(root,"packaging/provider-host-dependencies.json")
 os.WriteFile(dep,[]byte(`{"ollama":{"artifacts":{}}}`),0644)
 if err := run(root,true); err == nil { t.Fatal("regeneration accepted unmatched dependency") }
}
