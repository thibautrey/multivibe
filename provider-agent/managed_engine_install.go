package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// These pins are release inputs, compiled into the agent. Neither the Cloud,
// a local endpoint nor a model profile can supply installation instructions.
//
//go:embed managed_engines.json
var managedEngineManifest []byte

type managedEngineArtifact struct {
	URL     string `json:"url"`
	SHA256  string `json:"sha256"`
	Size    int64  `json:"size"`
	Archive string `json:"archive"`
}
type managedEngineRelease struct {
	ID          string                  `json:"id"`
	Version     string                  `json:"version"`
	Platform    string                  `json:"platform"`
	Accelerator string                  `json:"accelerator"`
	Backend     string                  `json:"backend"`
	Executable  string                  `json:"executable"`
	Artifacts   []managedEngineArtifact `json:"artifacts"`
	License     string                  `json:"license"`
	SourceURL   string                  `json:"source_url"`
}

func managedEngineReleases(host hostCapability) ([]managedEngineRelease, error) {
	var manifest struct {
		SchemaVersion string                 `json:"schema_version"`
		Engines       []managedEngineRelease `json:"engines"`
	}
	decoder := json.NewDecoder(bytes.NewReader(managedEngineManifest))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&manifest) != nil || ensureJSONEOF(decoder) != nil || manifest.SchemaVersion != "managed-inference-engines-v1" || len(manifest.Engines) == 0 {
		return nil, errRuntimeBackendInvalid
	}
	var result []managedEngineRelease
	seen := map[string]bool{}
	for _, release := range manifest.Engines {
		key := release.ID + "/" + release.Platform + "/" + release.Accelerator
		if seen[key] || (release.ID != "llama-cpp" && release.ID != "llamafile") || !runtimeBackendExecutablePattern.MatchString(release.Version) || strings.ContainsAny(release.Version, "/\\") ||
			!safeManagedEnginePath(release.Executable) || len(release.Artifacts) < 1 || len(release.Artifacts) > 2 || release.License == "" {
			return nil, errRuntimeBackendInvalid
		}
		seen[key] = true
		source := "https://github.com/ggml-org/llama.cpp"
		if release.ID == "llamafile" {
			source = "https://github.com/mozilla-ai/llamafile"
		}
		if release.SourceURL != source {
			return nil, errRuntimeBackendInvalid
		}
		for _, artifact := range release.Artifacts {
			u, err := url.Parse(artifact.URL)
			if err != nil || !managedEngineDownloadURL(u) || !strings.HasPrefix(artifact.URL, source+"/releases/download/"+release.Version+"/") ||
				!validManagedOllamaSHA256(artifact.SHA256) || artifact.Size < 1 || artifact.Size > managedOllamaArchiveMaxBytes ||
				(artifact.Archive != "tar.gz" && artifact.Archive != "zip" && artifact.Archive != "file") {
				return nil, errRuntimeBackendInvalid
			}
		}
		if release.Platform != host.OS+"-"+host.Architecture || release.Accelerator != host.Accelerator {
			continue
		}
		// CUDA_VISIBLE_DEVICES cannot pin a Vulkan device. Until Vulkan UUID
		// discovery is implemented, never select this build on a multi-GPU host.
		if release.Backend == "vulkan" && len(host.GPUs) != 1 {
			continue
		}
		result = append(result, release)
	}
	return result, nil
}

func managedEngineDownloadURL(u *url.URL) bool {
	return u != nil && u.Scheme == "https" && u.User == nil && u.Port() == "" && u.Fragment == "" &&
		(u.Hostname() == "github.com" || u.Hostname() == "release-assets.githubusercontent.com" || u.Hostname() == "objects.githubusercontent.com")
}

func managedEngineHTTPClient() *http.Client {
	return &http.Client{CheckRedirect: func(r *http.Request, previous []*http.Request) error {
		if len(previous) > 3 || !managedEngineDownloadURL(r.URL) {
			return errors.New("managed engine download redirect rejected")
		}
		r.Header.Del("Authorization")
		r.Header.Del("Cookie")
		return nil
	}}
}

func managedEnginePin(release managedEngineRelease) string {
	raw, _ := json.Marshal(release)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func (engines *managedInferenceEngines) install(ctx context.Context, policy *capacityPolicyStateDocument, release managedEngineRelease) (string, error) {
	parent := filepath.Join(engines.manager.root, "engines")
	if err := ensureManagedOllamaDirectory(parent, true); err != nil {
		return "", err
	}
	destination := filepath.Join(parent, release.ID+"-"+managedEnginePin(release))
	if _, err := os.Lstat(destination); err == nil {
		return verifyManagedEngineInstallation(destination, release)
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if _, err := engines.manager.authorizePolicy(policy, true); err != nil {
		return "", err
	}
	ctx, cancel := managedOllamaBoundContext(ctx, managedOllamaDefaultInstallTimeout)
	defer cancel()
	staging, err := os.MkdirTemp(parent, ".install-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(staging)
	if err = secureProviderPrivateDirectory(staging); err != nil {
		return "", err
	}
	for _, artifact := range release.Artifacts {
		archive, err := engines.download(ctx, artifact)
		if err != nil {
			return "", err
		}
		err = extractManagedEngine(ctx, archive, staging, release.Executable, artifact.Archive)
		_ = os.Remove(archive)
		if err != nil {
			return "", err
		}
	}
	executable := filepath.Join(staging, filepath.FromSlash(release.Executable))
	info, err := os.Lstat(executable)
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("managed engine executable is missing")
	}
	if err = secureManagedOllamaTree(staging, executable); err != nil {
		return "", err
	}
	tree, err := managedOllamaRuntimeTreeSHA256(staging)
	if err != nil {
		return "", err
	}
	record, _ := json.Marshal(struct{ Pin, Tree string }{managedEnginePin(release), tree})
	if err = atomicWrite0600(filepath.Join(staging, ".multivibe-runtime.json"), record); err != nil {
		return "", err
	}
	// Serialize the final commit with policy observation, as for Ollama.
	if _, err = engines.manager.lockAuthorizedPolicy(policy, true); err != nil {
		return "", err
	}
	err = ctx.Err()
	if err == nil {
		err = os.Rename(staging, destination)
	}
	engines.manager.mu.Unlock()
	if err != nil {
		return "", err
	}
	return verifyManagedEngineInstallation(destination, release)
}

func verifyManagedEngineInstallation(root string, release managedEngineRelease) (string, error) {
	raw, _, err := readManagedOllamaStableRegularFile(filepath.Join(root, ".multivibe-runtime.json"), 4096)
	var record struct{ Pin, Tree string }
	if err != nil || json.Unmarshal(raw, &record) != nil || record.Pin != managedEnginePin(release) {
		return "", errors.New("managed engine installation pin mismatch")
	}
	tree, err := managedOllamaRuntimeTreeSHA256(root)
	if err != nil || tree != record.Tree {
		return "", errors.New("managed engine installation integrity check failed")
	}
	executable := filepath.Join(root, filepath.FromSlash(release.Executable))
	info, err := os.Lstat(executable)
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("managed engine executable is unsafe")
	}
	return executable, nil
}

func (engines *managedInferenceEngines) download(ctx context.Context, artifact managedEngineArtifact) (string, error) {
	u, err := url.Parse(artifact.URL)
	if err != nil || !managedEngineDownloadURL(u) {
		return "", errRuntimeBackendInvalid
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, artifact.URL, nil)
	if err != nil {
		return "", err
	}
	response, err := engines.downloadClient.Do(req)
	if err != nil {
		return "", errors.New("managed engine download failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Header.Get("Content-Range") != "" || (response.ContentLength >= 0 && response.ContentLength != artifact.Size) {
		return "", errors.New("managed engine download size mismatch")
	}
	file, err := os.CreateTemp(filepath.Join(engines.manager.root, "downloads"), ".engine-*")
	if err != nil {
		return "", err
	}
	keep := false
	defer func() {
		file.Close()
		if !keep {
			os.Remove(file.Name())
		}
	}()
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, artifact.Size+1))
	if err != nil || n != artifact.Size || hex.EncodeToString(hash.Sum(nil)) != artifact.SHA256 {
		return "", errors.New("managed engine download checksum mismatch")
	}
	if err = file.Sync(); err != nil {
		return "", err
	}
	if err = file.Close(); err != nil {
		return "", err
	}
	keep = true
	return file.Name(), nil
}

// Extract in Go, never with a shell or an archive-provided executable. Symlinks
// are deferred and materialized as files, so later entries cannot traverse them.
func extractManagedEngine(ctx context.Context, archive, destination, executable, format string) error {
	links := map[string]string{}
	seen := map[string]bool{}
	var total int64
	write := func(name string, size int64, reader io.Reader, directory bool) error {
		name = strings.TrimSuffix(name, "/")
		if !safeManagedEnginePath(name) || name == ".multivibe-runtime.json" || seen[name] || len(seen) >= 10000 {
			return errors.New("managed engine archive path rejected")
		}
		seen[name] = true
		path := filepath.Join(destination, filepath.FromSlash(name))
		if directory {
			return ensureManagedOllamaDirectory(path, true)
		}
		if size < 0 || total > managedOllamaArchiveMaxBytes-size {
			return errors.New("managed engine archive exceeds extraction limit")
		}
		total += size
		if err := ensureManagedOllamaDirectory(filepath.Dir(path), true); err != nil {
			return err
		}
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o700)
		if err != nil {
			return err
		}
		n, err := io.CopyN(f, managedOllamaContextReader{ctx: ctx, reader: reader}, size)
		closeErr := f.Close()
		if err != nil || n != size {
			return errors.New("managed engine archive is truncated")
		}
		return closeErr
	}
	switch format {
	case "tar.gz":
		f, err := os.Open(archive)
		if err != nil {
			return err
		}
		defer f.Close()
		gz, err := gzip.NewReader(f)
		if err != nil {
			return err
		}
		defer gz.Close()
		reader := tar.NewReader(gz)
		for {
			h, err := reader.Next()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return err
			}
			if h.Typeflag == tar.TypeSymlink {
				name := strings.TrimSuffix(h.Name, "/")
				if !safeManagedEnginePath(name) || !safeManagedEnginePath(h.Linkname) || seen[name] || len(seen) >= 10000 {
					return errors.New("managed engine archive link rejected")
				}
				seen[name] = true
				links[name] = filepath.ToSlash(filepath.Join(filepath.Dir(name), h.Linkname))
			} else if h.Typeflag == tar.TypeReg || h.Typeflag == tar.TypeDir {
				if err := write(h.Name, h.Size, reader, h.Typeflag == tar.TypeDir); err != nil {
					return err
				}
			} else {
				return errors.New("managed engine archive entry type rejected")
			}
		}
	case "zip":
		z, err := zip.OpenReader(archive)
		if err != nil {
			return err
		}
		defer z.Close()
		for _, entry := range z.File {
			if entry.Mode()&os.ModeSymlink != 0 || entry.UncompressedSize64 > uint64(managedOllamaArchiveMaxBytes) {
				return errors.New("managed engine zip entry rejected")
			}
			r, err := entry.Open()
			if err != nil {
				return err
			}
			err = write(entry.Name, int64(entry.UncompressedSize64), r, entry.FileInfo().IsDir())
			r.Close()
			if err != nil {
				return err
			}
		}
	case "file":
		f, err := os.Open(archive)
		if err != nil {
			return err
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			return err
		}
		if err = write(executable, info.Size(), f, false); err != nil {
			return err
		}
	default:
		return errRuntimeBackendInvalid
	}
	for len(links) > 0 {
		progress := false
		for name, target := range links {
			if _, pending := links[target]; pending {
				continue
			}
			if !seen[target] {
				return errors.New("managed engine archive has a dangling link")
			}
			f, err := os.Open(filepath.Join(destination, filepath.FromSlash(target)))
			if err != nil {
				return err
			}
			info, err := f.Stat()
			if err != nil || !info.Mode().IsRegular() {
				f.Close()
				return errors.New("managed engine link target rejected")
			}
			delete(seen, name)
			err = write(name, info.Size(), f, false)
			f.Close()
			if err != nil {
				return err
			}
			delete(links, name)
			progress = true
		}
		if !progress {
			return errors.New("managed engine archive has cyclic links")
		}
	}
	return ctx.Err()
}

func safeManagedEnginePath(value string) bool {
	return safeManagedOllamaArchivePath(value) && value != "." && path.Clean(value) == value && !strings.ContainsAny(value, ":\\")
}
