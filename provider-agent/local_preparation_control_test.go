package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLocalPreparationControlBoundary(t *testing.T) {
	input := localPreparationOperation{Operation: "download", PolicyRevision: 1, ContextTokens: 2048, Artifact: localPreparationArtifact{ModelID: "author/model", Revision: strings.Repeat("a", 40), Filename: "model.gguf", SHA256: strings.Repeat("b", 64), Bytes: 10}}
	raw, _ := json.Marshal(input)
	for _, mode := range []string{"success", "unauthorized", "unknown-field", "unknown-operation", "duplicate", "oversize", "failure", "regressing-progress"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			handler := localPreparationOperationHandler(strings.Repeat("s", 32), func(ctx context.Context, in localPreparationOperation, progress managedModelDownloadProgress) (string, error) {
				calls++
				if mode == "failure" {
					return "", errors.New("secret runtime path")
				}
				if err := progress(5, 10); err != nil {
					return "", err
				}
				if mode == "regressing-progress" {
					return "", progress(4, 10)
				}
				return "", progress(10, 10)
			})
			body := string(raw)
			switch mode {
			case "unknown-field":
				body = strings.TrimSuffix(body, "}") + `,"path":"/private"}`
			case "unknown-operation":
				body = strings.Replace(body, `"download"`, `"delete"`, 1)
			case "duplicate":
				body = strings.TrimSuffix(body, "}") + `,"policy_revision":2}`
			case "oversize":
				body = strings.Repeat("x", 4097)
			}
			request := httptest.NewRequest("POST", "/v1/local-preparation/operation", strings.NewReader(body))
			request.Header.Set("content-type", "application/json")
			if mode != "unauthorized" {
				request.Header.Set("authorization", "Bearer "+strings.Repeat("s", 32))
			}
			response := httptest.NewRecorder()
			handler(response, request)
			if mode == "unauthorized" {
				if response.Code != 404 || calls != 0 {
					t.Fatal(response.Code, calls)
				}
				return
			}
			if mode == "unknown-field" || mode == "unknown-operation" || mode == "duplicate" || mode == "oversize" {
				if response.Code != 400 || calls != 0 {
					t.Fatal(response.Code, calls)
				}
				return
			}
			if calls != 1 || response.Code != 200 {
				t.Fatal(calls, response.Code)
			}
			text := response.Body.String()
			if mode == "success" {
				if !strings.Contains(text, `"type":"complete"`) || !strings.Contains(text, `"completed_bytes":10`) {
					t.Fatal(text)
				}
			} else if strings.Contains(text, `"type":"complete"`) || !strings.Contains(text, `"type":"error"`) {
				t.Fatal(text)
			}
			if strings.Contains(text, "secret runtime path") {
				t.Fatal("raw diagnostic escaped")
			}
		})
	}
}
func TestLocalPreparationControlUnavailable(t *testing.T) {
	input := localPreparationOperation{Operation: "install", PolicyRevision: 1, ContextTokens: 2048, Artifact: localPreparationArtifact{ModelID: "author/model", Revision: strings.Repeat("a", 40), Filename: "model.gguf", SHA256: strings.Repeat("b", 64), Bytes: 10}}
	raw, _ := json.Marshal(input)
	request := httptest.NewRequest("POST", "/", strings.NewReader(string(raw)))
	request.Header.Set("authorization", "Bearer "+strings.Repeat("s", 32))
	request.Header.Set("content-type", "application/json")
	response := httptest.NewRecorder()
	localPreparationControlHandler(nil, strings.Repeat("s", 32))(response, request)
	if !strings.Contains(response.Body.String(), `"type":"error"`) {
		t.Fatal(response.Body.String())
	}
}

func TestLocalPreparationControlProbe(t *testing.T) {
	for _, identity := range []string{"multivibe-local-" + strings.Repeat("a", 32) + ":latest", "cloud/model", ""} {
		calls := 0
		input := localPreparationOperation{Operation: "test", RuntimeModel: identity, PolicyRevision: 1, ContextTokens: 2048, Artifact: localPreparationArtifact{ModelID: "author/model", Revision: strings.Repeat("a", 40), Filename: "model.gguf", SHA256: strings.Repeat("b", 64), Bytes: 10}}
		raw, _ := json.Marshal(input)
		request := httptest.NewRequest("POST", "/", strings.NewReader(string(raw)))
		request.Header.Set("authorization", "Bearer "+strings.Repeat("s", 32))
		request.Header.Set("content-type", "application/json")
		response := httptest.NewRecorder()
		localPreparationOperationHandler(strings.Repeat("s", 32), func(ctx context.Context, input localPreparationOperation, progress managedModelDownloadProgress) (string, error) {
			calls++
			return "OK", nil
		})(response, request)
		if identity == "" || identity == "cloud/model" {
			if calls != 0 || response.Code != 400 {
				t.Fatal("invalid probe accepted")
			}
		} else if calls != 1 || !strings.Contains(response.Body.String(), `"output":"OK"`) || strings.Contains(response.Body.String(), `"runtime_model"`) {
			t.Fatal("invalid probe output", response.Body.String())
		}
	}
}
