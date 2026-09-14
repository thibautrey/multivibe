package main

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"os"
)

// Validate the sum of declared regular-file sizes before native tar creates
// anything. This protects the disk reservation from a small compressed archive
// expanding beyond the managed-runtime limit. Paths are validated separately.
func validateManagedOllamaGzipSize(ctx context.Context, archive string) error {
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
	return validateManagedOllamaTarSize(ctx, gz)
}
func validateManagedOllamaTarSize(ctx context.Context, source io.Reader) error {
	// Bound tar framing/padding too, including malformed streams and PAX data.
	reader := tar.NewReader(io.LimitReader(source, managedOllamaArchiveMaxBytes+64*1024*1024))
	var total int64
	entries := 0
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		header, err := reader.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		entries++
		if entries > 100000 || header.Size < 0 || header.Size > managedOllamaArchiveMaxBytes-total {
			return errors.New("managed Ollama archive exceeds extraction limit")
		}
		total += header.Size
	}
}
