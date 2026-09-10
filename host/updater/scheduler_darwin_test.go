package main

import (
	"bytes"
	"encoding/xml"
	"io"
	"strings"
	"testing"
)

func TestSchedulerPlistEscapesInstalledPaths(t *testing.T) {
	data := schedulerPlist("/Applications/MultiVibe Host.app/Contents/Helpers/updater", "/Users/A&B/Library/Application Support/MultiVibe")
	decoder := xml.NewDecoder(bytes.NewReader(data))
	for {
		_, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, want := range []string{"A&amp;B", "<integer>60</integer>", "<string>auto</string>", "MULTIVIBE_HOST_DATA_DIR", "MULTIVIBE_CONTROL_PLANE_PORT", "1456"} {
		if !strings.Contains(string(data), want) {
			t.Fatalf("missing %s", want)
		}
	}
	if strings.Contains(string(data), "RunAtLoad") {
		t.Fatal("scheduler must not race host startup")
	}
}
