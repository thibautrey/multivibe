package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestExecutableLayoutIsBoundedToReleaseShape(t *testing.T) {
	mac, err := executableLayout("/Applications/MultiVibe Host.app/Contents/MacOS/multivibe-host", "darwin")
	if err != nil || mac.Node != "/Applications/MultiVibe Host.app/Contents/Frameworks/node" ||
		mac.Updater != "/Applications/MultiVibe Host.app/Contents/Helpers/multivibe-host-updater" ||
		mac.App != "/Applications/MultiVibe Host.app/Contents/Resources/app" {
		t.Fatalf("unexpected macOS layout: %#v %v", mac, err)
	}
	linux, err := executableLayout("/opt/multivibe-host/bin/multivibe-host", "linux")
	if err != nil || linux.Node != "/opt/multivibe-host/bin/node" || linux.App != "/opt/multivibe-host/app" ||
		linux.Updater != "/opt/multivibe-host/bin/multivibe-host-updater" ||
		linux.Security != "/opt/multivibe-host/app/modules/security" {
		t.Fatalf("unexpected Linux layout: %#v %v", linux, err)
	}
	for _, invalid := range []struct{ path, goos string }{
		{"/tmp/multivibe-host", "darwin"},
		{"/tmp/multivibe-host", "linux"},
		{"/opt/multivibe-host/bin/multivibe-host", "windows"},
	} {
		if _, err := executableLayout(invalid.path, invalid.goos); err == nil {
			t.Fatalf("accepted invalid layout %#v", invalid)
		}
	}
}

func TestDataDirectoryKeepsHosterChoiceExplicit(t *testing.T) {
	mac, err := defaultDataDirectory("darwin", "/Users/provider", "")
	if err != nil || mac != "/Users/provider/Library/Application Support/MultiVibe" {
		t.Fatalf("unexpected macOS data path: %q %v", mac, err)
	}
	linux, err := defaultDataDirectory("linux", "/home/provider", "/mnt/fast/provider-data")
	if err != nil || linux != "/mnt/fast/provider-data/multivibe" {
		t.Fatalf("unexpected Linux data path: %q %v", linux, err)
	}
	if _, err := defaultDataDirectory("linux", "/home/provider", "relative"); err == nil {
		t.Fatal("accepted a relative hoster data path")
	}
}

func TestCredentialsAreAtomicPrivateAndStable(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "state")
	first, err := loadOrCreateCredentials(directory)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateCredentials(first); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(credentialPath(directory))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("credentials permissions are unsafe: %#v %v", info, err)
	}
	second, err := loadOrCreateCredentials(directory)
	if err != nil || second != first {
		t.Fatalf("credentials changed across restart: %#v %#v %v", first, second, err)
	}
	raw, err := os.ReadFile(credentialPath(directory))
	if err != nil || !json.Valid(raw) || strings.Contains(string(raw), ".new") {
		t.Fatalf("invalid credential state: %q %v", raw, err)
	}
}

func TestCredentialsRejectTrailingJSON(t *testing.T) {
	directory := t.TempDir()
	path := credentialPath(directory)
	raw := `{"schema_version":"multivibe-host-credentials-v1","admin_token":"` +
		strings.Repeat("a", 32) + `","proxy_api_key":"` + strings.Repeat("b", 32) + `"}` + "\n{}\n"
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadOrCreateCredentials(directory); err == nil {
		t.Fatal("accepted a second JSON value after the credential object")
	}
}

func TestCoreEnvironmentIsAllowlistedAndPinsAllState(t *testing.T) {
	t.Setenv("UNRELATED_SECRET", "must-not-leak")
	t.Setenv("MODELS_CLIENT_VERSION", "0.144.1")
	t.Setenv("MULTIVIBE_HOST_CONTAINER", "")
	layout := bundleLayout{
		Security: "/opt/multivibe/app/modules/security",
		Updater:  "/opt/multivibe/bin/updater",
	}
	environment := coreEnvironment(
		layout,
		"/var/lib/multivibe",
		localCredentials{AdminToken: "admin", ProxyAPIKey: "proxy"},
		coreNetworkConfiguration{
			BindAddress: "0.0.0.0", Port: "1455", PublicBaseURL: "https://multivibe.home.example.com",
		},
	)
	joined := strings.Join(environment, "\n")
	expectedHost, expectedPort := "0.0.0.0", "1455"
	if runtime.GOOS == "darwin" {
		expectedHost, expectedPort = "127.0.0.1", "1456"
	}
	expectedNetwork := []string{"HOST=" + expectedHost, "PORT=" + expectedPort}
	if runtime.GOOS == "darwin" {
		expectedNetwork = append(expectedNetwork, "CONTROL_PLANE_PORT=1456", "MULTIVIBE_CONTROL_PLANE=true")
	}
	expectedNetwork = append(expectedNetwork, "PUBLIC_BASE_URL=https://multivibe.home.example.com")
	for _, expected := range append(expectedNetwork,
		"OAUTH_REDIRECT_URI=https://multivibe.home.example.com/auth/callback",
		"STORE_PATH=/var/lib/multivibe/accounts.json",
		"MULTIVIBE_HOST_APPLICATION=true",
		"MULTIVIBE_HOST_UPDATER_BINARY=/opt/multivibe/bin/updater",
		"APP_VERSION=dev",
		"MODELS_CLIENT_VERSION=1.0.0",
		"TRACE_INCLUDE_BODY=false", "BUNDLED_SECURITY_MODULE_PATH=/opt/multivibe/app/modules/security",
	) {
		if !strings.Contains(joined, expected) {
			t.Fatalf("missing environment contract %q in %s", expected, joined)
		}
	}
	if strings.Contains(joined, "PROVIDER_AGENT_") || strings.Contains(joined, "UNRELATED_SECRET") || strings.Contains(joined, "must-not-leak") ||
		strings.Contains(joined, "must-not-override-the-bundle") || strings.Contains(joined, "MODELS_CLIENT_VERSION=0.144.1") {
		t.Fatalf("parent environment leaked: %s", joined)
	}
}

func TestHostBindAddressPreservesLoopbackDefaultAndBoundsExposure(t *testing.T) {
	for input, expected := range map[string]string{
		"": "127.0.0.1", "127.0.0.1": "127.0.0.1", "::1": "::1", "0.0.0.0": "0.0.0.0", "::": "::",
	} {
		if actual, err := hostBindAddress(input); err != nil || actual != expected {
			t.Fatalf("unexpected bind address for %q: %q %v", input, actual, err)
		}
	}
	for _, input := range []string{"localhost", "127.0.0.2", "192.168.1.20", "*", " 0.0.0.0"} {
		if _, err := hostBindAddress(input); err == nil {
			t.Fatalf("accepted unsafe or ambiguous bind address %q", input)
		}
	}
}

func TestHostPublicBaseURLRequiresAnExplicitCleanOriginWhenExposed(t *testing.T) {
	for _, test := range []struct {
		value, bind, port, expected string
	}{
		{"", "127.0.0.1", "1455", "http://127.0.0.1:1455"},
		{"", "::1", "1455", "http://[::1]:1455"},
		{"http://192.168.1.20:1455", "0.0.0.0", "1455", "http://192.168.1.20:1455"},
		{"https://multivibe.home.example.com/", "0.0.0.0", "1455", "https://multivibe.home.example.com"},
	} {
		actual, err := hostPublicBaseURL(test.value, test.bind, test.port)
		if err != nil || actual != test.expected {
			t.Fatalf("unexpected public URL for %#v: %q %v", test, actual, err)
		}
	}
	for _, test := range []struct{ value, bind string }{
		{"", "0.0.0.0"},
		{"ftp://multivibe.example.com", "0.0.0.0"},
		{"http://user:pass@multivibe.example.com", "0.0.0.0"},
		{"https://multivibe.example.com/app", "0.0.0.0"},
		{"https://multivibe.example.com?redirect=elsewhere", "0.0.0.0"},
		{"https://multivibe.example.com#fragment", "0.0.0.0"},
		{"https://multivibe.example.com:01455", "0.0.0.0"},
		{"https://multivibe.example.com:", "0.0.0.0"},
		{"https://[::1]:", "0.0.0.0"},
		{" http://192.168.1.20:1455", "0.0.0.0"},
	} {
		if _, err := hostPublicBaseURL(test.value, test.bind, "1455"); err == nil {
			t.Fatalf("accepted invalid public URL %q", test.value)
		}
	}
}

func TestHostPortIsBoundedAndCanonical(t *testing.T) {
	for input, expected := range map[string]string{"": "1455", "1": "1", "1455": "1455", "65535": "65535"} {
		if actual, err := hostPort(input); err != nil || actual != expected {
			t.Fatalf("unexpected host port for %q: %q %v", input, actual, err)
		}
	}
	for _, input := range []string{"0", "01", "65536", "-1", "1455 ", "http://127.0.0.1:1455"} {
		if _, err := hostPort(input); err == nil {
			t.Fatalf("accepted invalid host port %q", input)
		}
	}
}

func TestSignalAndWaitForChildAllowsGracefulCleanup(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX signal behavior")
	}
	marker := filepath.Join(t.TempDir(), "stopped")
	ready := marker + ".ready"
	child := exec.Command("/bin/sh", "-c", `trap 'printf stopped > "$1"; exit 0' TERM; printf ready > "$2"; while :; do sleep 1; done`, "multivibe-child", marker, ready)
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- child.Wait() }()
	t.Cleanup(func() { _ = child.Process.Kill() })
	deadline := time.Now().Add(10 * time.Second)
	for {
		if value, err := os.ReadFile(ready); err == nil && string(value) == "ready" {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("child exited before installing its signal handler: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("child did not install its signal handler")
		}
		time.Sleep(10 * time.Millisecond)
	}
	signalAndWaitForChild(child.Process, done, syscall.SIGTERM)
	if value, err := os.ReadFile(marker); err != nil || string(value) != "stopped" {
		t.Fatalf("child did not complete graceful cleanup: %q %v", value, err)
	}
}
