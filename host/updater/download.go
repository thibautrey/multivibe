package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

// Parts are addressed by their signed digest. Interrupted transfers can resume
// across scheduler runs, but no cached bytes are trusted until the complete part
// matches the signed size and SHA-256. Immutable release URLs may ignore Range;
// in that case restart this part rather than appending a second full response.
func (update *updater) cachedPart(ctx context.Context, part artifactPart) (string, error) {
	if !hexDigestPattern.MatchString(part.SHA256) || part.Size < 1 || part.Size > maximumArtifactBytes {
		return "", errors.New("the update archive part identity is invalid")
	}
	path := filepath.Join(update.store.cache, ".part-"+part.SHA256)
	if info, err := os.Lstat(path); err == nil {
		if !updaterPrivateFile(path, info) {
			return "", errors.New("the partial update file is unsafe")
		}
		if info.Size() > part.Size {
			return "", errors.New("the partial update file exceeds the signed size")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return "", err
	}
	defer file.Close()
	if err := secureUpdaterPrivateFile(path); err != nil {
		return "", err
	}
	info, err := file.Stat()
	if err != nil {
		return "", err
	}
	offset := info.Size()
	if offset < part.Size {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, part.URL, nil)
		if err != nil {
			return "", errors.New("the update archive request is invalid")
		}
		request.Header.Set("Accept", "application/octet-stream")
		request.Header.Set("Accept-Encoding", "identity")
		request.Header.Set("User-Agent", "MultiVibe-Host-Updater/"+hostUpdaterVersion)
		if offset > 0 {
			request.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
		}
		response, err := update.httpClient.Do(request)
		if err != nil {
			return "", errors.New("the update archive could not be downloaded")
		}
		defer response.Body.Close()
		switch response.StatusCode {
		case http.StatusOK:
			offset = 0
			if err := file.Truncate(0); err != nil {
				return "", err
			}
		case http.StatusPartialContent:
			expected := fmt.Sprintf("bytes %d-%d/%d", offset, part.Size-1, part.Size)
			if response.Header.Get("Content-Range") != expected {
				return "", errors.New("the update server returned an invalid byte range")
			}
		default:
			return "", fmt.Errorf("the update archive returned HTTP %d", response.StatusCode)
		}
		if _, err := file.Seek(offset, io.SeekStart); err != nil {
			return "", err
		}
		written, copyErr := io.Copy(file, io.LimitReader(response.Body, part.Size-offset+1))
		if offset+written > part.Size {
			_ = file.Close()
			_ = os.Remove(path)
			return "", errors.New("the update archive exceeds the signed size")
		}
		if err := file.Sync(); err != nil {
			return "", err
		}
		if copyErr != nil || offset+written != part.Size {
			return "", errors.New("the update archive transfer was interrupted; verified completion will resume on retry")
		}
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	if hex.EncodeToString(hash.Sum(nil)) != part.SHA256 {
		_ = file.Close()
		_ = os.Remove(path)
		return "", errors.New("the update archive part failed verification; the partial file was discarded")
	}
	return path, nil
}
