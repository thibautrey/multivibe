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

func TestSchedulerReconcilesLegacyLoadedDefinition(t *testing.T) {
	executable := "/Applications/MultiVibe Host.app/Contents/Helpers/multivibe-host-updater"
	desired := schedulerPlist(executable, "/Users/test/Library/Application Support/MultiVibe")
	loaded := "program = " + executable + "\nrun interval = 60 seconds\n"
	if !schedulerMatches(desired, desired, loaded, executable) {
		t.Fatal("current scheduler not recognized")
	}
	if schedulerMatches(desired, desired, strings.ReplaceAll(loaded, "60 seconds", "3600 seconds"), executable) {
		t.Fatal("legacy loaded interval accepted")
	}
	if schedulerMatches([]byte("old plist"), desired, loaded, executable) {
		t.Fatal("legacy plist accepted")
	}
}
