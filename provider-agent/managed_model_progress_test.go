package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func progressLine(digest string, total, completed uint64) string {
	b, _ := json.Marshal(map[string]any{"status": "pulling", "digest": digest, "total": total, "completed": completed})
	return string(b) + "\n"
}
func TestManagedModelProgressCountsDistinctBlobs(t *testing.T) {
	a, b := "sha256:"+strings.Repeat("a", 64), "sha256:"+strings.Repeat("b", 64)
	input := `{"status":"pulling manifest"}` + "\n" + progressLine(a, 10, 0) + progressLine(a, 10, 5) + progressLine(a, 10, 5) + progressLine(b, 6, 6) + progressLine(a, 10, 10) + `{"status":"success"}`
	var values []uint64
	err := readManagedModelProgress(context.Background(), strings.NewReader(input), 16, func(done, total uint64) error {
		if total != 16 {
			t.Fatal(total)
		}
		values = append(values, done)
		return nil
	})
	if err != nil || !reflect.DeepEqual(values, []uint64{0, 5, 5, 11, 16}) {
		t.Fatal(values, err)
	}
}
func TestManagedModelProgressFailsClosed(t *testing.T) {
	a := "sha256:" + strings.Repeat("a", 64)
	cases := map[string]string{
		"budget":         progressLine(a, 17, 0),
		"counter":        progressLine(a, 16, 17),
		"regression":     progressLine(a, 16, 10) + progressLine(a, 16, 5),
		"changed-size":   progressLine(a, 16, 1) + progressLine(a, 15, 2),
		"eof":            progressLine(a, 16, 16),
		"invalid-digest": progressLine("untrusted", 16, 1),
		"negative":       `{"digest":"` + a + `","total":16,"completed":-1}`,
		"duplicate-key":  `{"status":"success","status":"pulling"}`,
		"server-error":   `{"error":"private runtime error"}`,
		"oversized":      strings.Repeat("x", 65537),
	}
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			if err := readManagedModelProgress(context.Background(), strings.NewReader(input), 16, func(uint64, uint64) error { return nil }); err == nil {
				t.Fatal("accepted invalid stream")
			}
		})
	}
}
func TestManagedModelProgressCancellationAndCallbackFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := readManagedModelProgress(ctx, strings.NewReader(`{"status":"success"}`), 16, func(uint64, uint64) error { return nil }); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	sentinel := errors.New("persistence failed")
	if err := readManagedModelProgress(context.Background(), strings.NewReader(progressLine("sha256:"+strings.Repeat("a", 64), 16, 1)), 16, func(uint64, uint64) error { return sentinel }); !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
}
func TestManagedModelProgressUsesManagedOriginAndRejectsRedirect(t *testing.T) {
	calls := 0
	manager := newManagedOllamaTestManager(t, managedOllamaConfig{ManagedRoot: filepath.Join(t.TempDir(), "managed"), GOOS: "linux", GOARCH: "amd64", HTTPTransport: managedOllamaRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.String() != "http://127.0.0.1:11434/api/pull" || r.Method != "POST" {
			t.Fatal(r.URL, r.Method)
		}
		var payload map[string]any
		if json.NewDecoder(r.Body).Decode(&payload) != nil || payload["model"] != "qwen2.5:0.5b" || payload["stream"] != true || len(payload) != 2 {
			t.Fatal(payload)
		}
		return &http.Response{StatusCode: 307, Header: http.Header{"Location": []string{"https://github.com/ollama/ollama/releases/download/anything"}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
	})})
	if err := manager.streamModelPull(context.Background(), "qwen2.5:0.5b", 16, func(uint64, uint64) error { return nil }); err == nil {
		t.Fatal("redirect accepted")
	}
	if calls != 1 {
		t.Fatal("redirect followed", calls)
	}
}
