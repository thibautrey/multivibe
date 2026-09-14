package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// A local artifact is independent of Cloud workload admission. The preparation
// quote must supply compatibility evidence and exact consent before this method.
// No caller-supplied URL, runtime code, or model-card executable is accepted.
type localPreparationArtifact struct {
	ModelID  string `json:"model_id"`
	Revision string `json:"revision"`
	Filename string `json:"filename"`
	SHA256   string `json:"sha256"`
	Bytes    uint64 `json:"bytes"`
}

var localArtifactRepository = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
var localArtifactRevision = regexp.MustCompile(`^[a-f0-9]{40}$`)
var localArtifactHash = regexp.MustCompile(`^[a-f0-9]{64}$`)
var localArtifactShard = regexp.MustCompile(`-\d{5}-of-\d{5}\.gguf$`)

func (a localPreparationArtifact) sourceURL() (string, error) {
	if !localArtifactRepository.MatchString(a.ModelID) || !validSelectedModelID(a.ModelID) || !localArtifactRevision.MatchString(a.Revision) || !localArtifactHash.MatchString(a.SHA256) || a.Bytes == 0 || a.Bytes > 1<<53-1 || len(a.Filename) > 1024 || !strings.HasSuffix(a.Filename, ".gguf") || localArtifactShard.MatchString(a.Filename) {
		return "", errLocalPreparationArtifact
	}
	parts := strings.Split(a.Filename, "/")
	for i, part := range parts {
		if part == "" || part == "." || part == ".." || strings.ContainsAny(part, "\\%?#") {
			return "", errLocalPreparationArtifact
		}
		for _, r := range part {
			if r < 32 || r == 127 {
				return "", errLocalPreparationArtifact
			}
		}
		parts[i] = url.PathEscape(part)
	}
	return "https://huggingface.co/" + a.ModelID + "/resolve/" + a.Revision + "/" + strings.Join(parts, "/"), nil
}
func allowedLocalArtifactRedirect(u *url.URL) bool {
	if u == nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.Fragment != "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == "huggingface.co" || strings.HasSuffix(host, ".hf.co")
}

// Download to the managed model storage under the existing pull lock. This is
// deliberately non-resuming: failures remove only the new temporary file. Existing
// artifacts are verified, never overwritten or deleted. All bytes are hash checked
// before returning a path that the existing runtime may import.
func (manager *managedOllama) downloadLocalArtifact(ctx context.Context, storage string, artifact localPreparationArtifact, progress managedModelDownloadProgress) (string, error) {
	manager.pullMu.Lock()
	defer manager.pullMu.Unlock()
	source, err := artifact.sourceURL()
	if err != nil || progress == nil {
		return "", errLocalPreparationArtifact
	}
	if err = ctx.Err(); err != nil {
		return "", err
	}
	if _, err = localPreparationStorageBytes(ctx, storage); err != nil {
		return "", err
	}
	root := filepath.Join(storage, "local-artifacts")
	if err = os.Mkdir(root, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return "", errLocalPreparationStorage
	}
	if _, err = localPreparationStorageBytes(ctx, root); err != nil {
		return "", err
	}
	target := filepath.Join(root, artifact.SHA256+".gguf")
	if info, statErr := os.Lstat(target); statErr == nil {
		if !info.Mode().IsRegular() || uint64(info.Size()) != artifact.Bytes {
			return "", errLocalPreparationArtifact
		}
		file, openErr := os.Open(target)
		if openErr != nil {
			return "", errLocalPreparationStorage
		}
		defer file.Close()
		hash := sha256.New()
		count, copyErr := copyLocalArtifact(ctx, hash, file, artifact.Bytes, nil)
		if copyErr != nil || count != artifact.Bytes || hex.EncodeToString(hash.Sum(nil)) != artifact.SHA256 {
			return "", errLocalPreparationArtifact
		}
		if err = progress(count, count); err != nil {
			return "", err
		}
		return target, ctx.Err()
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return "", errLocalPreparationStorage
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return "", errLocalPreparationArtifact
	}
	request.Header.Set("Accept-Encoding", "identity")
	client := *manager.httpClient
	client.Jar = nil // Never attach credentials from an unrelated runtime request.
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) > 5 || !allowedLocalArtifactRedirect(req.URL) {
			return errLocalPreparationArtifact
		}
		req.Header.Del("Authorization")
		req.Header.Del("Cookie")
		req.Header.Del("Range")
		return nil
	}
	response, err := client.Do(request)
	if err != nil {
		return "", errLocalPreparationArtifact
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Header.Get("Content-Encoding") != "" && response.Header.Get("Content-Encoding") != "identity" || response.ContentLength >= 0 && uint64(response.ContentLength) != artifact.Bytes {
		return "", errLocalPreparationArtifact
	}
	file, err := os.CreateTemp(root, ".download-*")
	if err != nil {
		return "", errLocalPreparationStorage
	}
	defer os.Remove(file.Name())
	defer file.Close()
	hash := sha256.New()
	if err = progress(0, artifact.Bytes); err != nil {
		return "", err
	}
	count, err := copyLocalArtifact(ctx, io.MultiWriter(file, hash), response.Body, artifact.Bytes, progress)
	if err != nil {
		return "", err
	}
	if count != artifact.Bytes || hex.EncodeToString(hash.Sum(nil)) != artifact.SHA256 {
		return "", errLocalPreparationArtifact
	}
	if err = ctx.Err(); err != nil {
		return "", err
	}
	if err = file.Sync(); err != nil {
		return "", errLocalPreparationStorage
	}
	if err = file.Close(); err != nil {
		return "", errLocalPreparationStorage
	}
	// Link is an atomic no-replace commit, unlike Rename on Unix. Both are on the
	// same storage filesystem. An existing target (including symlinks) is untouched.
	if err = os.Link(file.Name(), target); err != nil {
		return "", errLocalPreparationStorage
	}
	return target, nil
}
func copyLocalArtifact(ctx context.Context, dst io.Writer, src io.Reader, maximum uint64, progress managedModelDownloadProgress) (uint64, error) {
	buffer := make([]byte, 256*1024)
	var count uint64
	for {
		if err := ctx.Err(); err != nil {
			return count, err
		}
		n, readErr := src.Read(buffer)
		if uint64(n) > maximum-count {
			return count, errLocalPreparationArtifact
		}
		if n > 0 {
			written, err := dst.Write(buffer[:n])
			if err != nil {
				return count, err
			}
			if written != n {
				return count, io.ErrShortWrite
			}
			count += uint64(n)
			if progress != nil {
				if err := progress(count, maximum); err != nil {
					return count, err
				}
			}
		}
		if readErr == io.EOF {
			return count, nil
		}
		if readErr != nil {
			return count, readErr
		}
		if n == 0 {
			return count, io.ErrNoProgress
		}
	}
}
