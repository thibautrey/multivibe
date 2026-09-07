package main

import (
	"encoding/json"
	"testing"
)

func TestOrdinaryRuntimeMinimizesIdentityWithoutChangingPrompt(t *testing.T) {
	body, err := reviewedOllamaExecutionBody([]byte(`{"model":"original","messages":[{"role":"user","content":"exact prompt"}],"metadata":{"account":"secret"},"user":"id","store":true}`), "reviewed:model", true)
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]json.RawMessage
	if json.Unmarshal(body, &parsed) != nil {
		t.Fatal("invalid body")
	}
	if _, ok := parsed["metadata"]; ok {
		t.Fatal("metadata leaked")
	}
	if _, ok := parsed["user"]; ok {
		t.Fatal("identity leaked")
	}
	if string(parsed["store"]) != "false" || string(parsed["messages"]) != `[{"role":"user","content":"exact prompt"}]` {
		t.Fatal("content or retention changed incorrectly")
	}
}

func TestOrdinaryRuntimeCannotFetchRemoteImages(t *testing.T) {
	for _, url := range []string{"https://example.com/image.png", "http://127.0.0.1/private", "file:///etc/passwd"} {
		body, _ := json.Marshal(map[string]any{"messages": []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "image_url", "image_url": map[string]string{"url": url}}}}}})
		if _, err := reviewedOllamaExecutionBody(body, "test:model", false); err == nil {
			t.Fatal("runtime network fetch accepted")
		}
	}
	if _, err := reviewedOllamaExecutionBody([]byte(`{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,aGVsbG8="}}]}]}`), "test:model", false); err != nil {
		t.Fatal(err)
	}
}
