// catalog-check validates reviewed runtime metadata without network access.
package main

import (
 "bytes"
 "encoding/json"
 "flag"
 "fmt"
 "os"
 "path/filepath"
 "github.com/thibautrey/multivibe/provider-agent/runtimeprofile"
)

func run(root string, write bool) error {
 catalogPath := filepath.Join(root, "packaging/provider-runtime-profiles.json")
 fixturePath := filepath.Join(root, "provider-agent/runtimeprofile/testdata/catalog-v3.golden.json")
 raw, err := os.ReadFile(catalogPath); if err != nil { return err }
 var catalog runtimeprofile.Catalog
 decoder := json.NewDecoder(bytes.NewReader(raw)); decoder.DisallowUnknownFields()
 if err := decoder.Decode(&catalog); err != nil { return err }
 var dependencies struct { Ollama struct { Artifacts map[string]struct { SHA256 string `json:"sha256"` } `json:"artifacts"` } `json:"ollama"` }
 dep, err := os.ReadFile(filepath.Join(root,"packaging/provider-host-dependencies.json")); if err != nil { return err }
 if err := json.Unmarshal(dep, &dependencies); err != nil { return err }
 for _, profile := range catalog.Profiles {
  if profile.Runtime.BackendID != "ollama-managed" { continue }
  target := profile.Hardware.OS + "-" + profile.Hardware.Architecture
  artifact, ok := dependencies.Ollama.Artifacts[target]
  if !ok || profile.Runtime.RuntimeArtifactDigest != "sha256:" + artifact.SHA256 {
   return fmt.Errorf("profile %s does not match the reviewed Ollama dependency for %s; reconcile source metadata before regenerating", profile.ID, target)
  }
 }
 finalized, err := runtimeprofile.Finalize(catalog); if err != nil { return err }
 if write {
  encoded, err := json.MarshalIndent(finalized, "", "  "); if err != nil { return err }; encoded = append(encoded, '\n')
  for _, name := range []string{catalogPath, fixturePath} { if err := os.WriteFile(name, encoded, 0644); err != nil { return err } }
  return nil
 }
 if err := runtimeprofile.Validate(catalog); err != nil { return fmt.Errorf("catalog digests are stale: run npm run catalog:refresh: %w", err) }
 fixture, err := os.ReadFile(fixturePath); if err != nil { return err }
 if !bytes.Equal(raw, fixture) { return fmt.Errorf("catalog golden fixture differs: run npm run catalog:refresh") }
 return nil
}
func main() {
 root := flag.String("root", "..", "repository root")
 write := flag.Bool("write", false, "recompute digests and synchronize the golden fixture")
 flag.Parse()
 if err := run(*root, *write); err != nil { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
 fmt.Println("Runtime catalog metadata is consistent.")
}
