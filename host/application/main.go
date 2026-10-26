package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var hostApplicationVersion = "dev"

type bundleLayout struct {
	Root     string
	Node     string
	Edge     string
	Updater  string
	App      string
	Security string
}

const (
	modelsClientVersion = "1.0.0"
)

type localCredentials struct {
	SchemaVersion string `json:"schema_version"`
	AdminToken    string `json:"admin_token"`
	ProxyAPIKey   string `json:"proxy_api_key"`
}

type coreNetworkConfiguration struct {
	BindAddress   string
	Port          string
	PublicBaseURL string
}

func main() {
	if len(os.Args) != 2 {
		fatal("usage: multivibe-host <doctor|init|run|version>")
	}
	switch os.Args[1] {
	case "version", "--version", "-version":
		fmt.Fprintln(os.Stdout, hostApplicationVersion)
	case "doctor":
		if err := doctor(os.Stdout); err != nil {
			fatal(err.Error())
		}
	case "init":
		path, err := initializeState()
		if err != nil {
			fatal(err.Error())
		}
		fmt.Fprintf(os.Stdout, "MultiVibe Host state initialized at %s\n", path)
	case "run":
		if err := run(); err != nil {
			fatal(err.Error())
		}
	default:
		fatal("unknown MultiVibe Host command")
	}
}

func fatal(message string) {
	fmt.Fprintf(os.Stderr, "multivibe-host: %s\n", message)
	os.Exit(2)
}

func executableLayout(executable, goos string) (bundleLayout, error) {
	executable, err := filepath.Abs(executable)
	if err != nil || filepath.Clean(executable) != executable {
		return bundleLayout{}, errors.New("the application path is invalid")
	}
	if goos == "darwin" {
		macOSDirectory := filepath.Dir(executable)
		contents := filepath.Dir(macOSDirectory)
		if filepath.Base(macOSDirectory) != "MacOS" || filepath.Base(contents) != "Contents" {
			return bundleLayout{}, errors.New("the macOS application layout is invalid")
		}
		return bundleLayout{
			Root:     filepath.Dir(contents),
			Node:     filepath.Join(contents, "Frameworks", "node"),
			Edge:     filepath.Join(contents, "Helpers", "multivibe-v1-edge"),
			Updater:  filepath.Join(contents, "Helpers", "multivibe-host-updater"),
			App:      filepath.Join(contents, "Resources", "app"),
			Security: filepath.Join(contents, "Resources", "app", "modules", "security"),
		}, nil
	}
	if goos == "windows" {
		bin := filepath.Dir(executable)
		root := filepath.Dir(bin)
		if filepath.Base(bin) != "bin" || strings.ToLower(filepath.Ext(executable)) != ".exe" {
			return bundleLayout{}, errors.New("the Windows application layout is invalid")
		}
		return bundleLayout{
			Root:     root,
			Node:     filepath.Join(bin, "node.exe"),
			Updater:  filepath.Join(bin, "multivibe-host-updater.exe"),
			App:      filepath.Join(root, "app"),
			Security: filepath.Join(root, "app", "modules", "security"),
		}, nil
	}
	if goos != "linux" {
		return bundleLayout{}, errors.New("the operating system is unsupported")
	}
	bin := filepath.Dir(executable)
	root := filepath.Dir(bin)
	if filepath.Base(bin) != "bin" {
		return bundleLayout{}, errors.New("the Linux application layout is invalid")
	}
	return bundleLayout{
		Root:     root,
		Node:     filepath.Join(bin, "node"),
		Updater:  filepath.Join(bin, "multivibe-host-updater"),
		App:      filepath.Join(root, "app"),
		Security: filepath.Join(root, "app", "modules", "security"),
	}, nil
}

func currentLayout() (bundleLayout, error) {
	executable, err := os.Executable()
	if err != nil {
		return bundleLayout{}, errors.New("the application path is unavailable")
	}
	return executableLayout(executable, runtime.GOOS)
}

func requireRegular(path string, executable bool) error {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("required bundle file is unavailable: %s", filepath.Base(path))
	}
	if executable && !hostExecutableFile(path, info) {
		return fmt.Errorf("required bundle file is not executable: %s", filepath.Base(path))
	}
	return nil
}

func validateLayout(layout bundleLayout) error {
	for _, candidate := range []struct {
		path       string
		executable bool
	}{
		{layout.Node, true},
		{layout.Updater, true},
		{filepath.Join(layout.App, "dist", "server.js"), false},
		{filepath.Join(layout.App, "dist", "instrument.js"), false},
		{filepath.Join(layout.App, "package.json"), false},
	} {
		if err := requireRegular(candidate.path, candidate.executable); err != nil {
			return err
		}
	}
	if runtime.GOOS == "darwin" {
		if err := requireRegular(layout.Edge, true); err != nil {
			return err
		}
	}
	security, err := os.Lstat(layout.Security)
	if err != nil || !security.IsDir() || security.Mode()&os.ModeSymlink != 0 {
		return errors.New("the bundled security module is unavailable")
	}
	return nil
}

func doctor(output io.Writer) error {
	layout, err := currentLayout()
	if err != nil {
		return err
	}
	if err := validateLayout(layout); err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(map[string]any{
		"schema_version": "multivibe-host-doctor-v1",
		"version":        hostApplicationVersion,
		"bundle":         "valid",
		"platform":       map[string]any{"os": runtime.GOOS, "architecture": runtime.GOARCH, "supported": true},
	})
}

func defaultDataDirectory(goos string, home string, xdg string) (string, error) {
	if home == "" || !filepath.IsAbs(home) {
		return "", errors.New("the user home directory is unavailable")
	}
	if goos == "darwin" {
		return filepath.Join(home, "Library", "Application Support", "MultiVibe"), nil
	}
	if goos == "windows" {
		if xdg != "" {
			if !filepath.IsAbs(xdg) || filepath.Clean(xdg) != xdg {
				return "", errors.New("LOCALAPPDATA must be a clean absolute path")
			}
			return filepath.Join(xdg, "MultiVibe"), nil
		}
		return filepath.Join(home, "AppData", "Local", "MultiVibe"), nil
	}
	if goos != "linux" {
		return "", errors.New("the operating system is unsupported")
	}
	if xdg != "" {
		if !filepath.IsAbs(xdg) || filepath.Clean(xdg) != xdg {
			return "", errors.New("XDG_DATA_HOME must be a clean absolute path")
		}
		return filepath.Join(xdg, "multivibe"), nil
	}
	return filepath.Join(home, ".local", "share", "multivibe"), nil
}

func dataDirectory() (string, error) {
	if configured := strings.TrimSpace(os.Getenv("MULTIVIBE_HOST_DATA_DIR")); configured != "" {
		if !filepath.IsAbs(configured) || filepath.Clean(configured) != configured {
			return "", errors.New("MULTIVIBE_HOST_DATA_DIR must be a clean absolute path")
		}
		return configured, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errors.New("the user home directory is unavailable")
	}
	dataHome := os.Getenv("XDG_DATA_HOME")
	if runtime.GOOS == "windows" {
		dataHome = os.Getenv("LOCALAPPDATA")
	}
	return defaultDataDirectory(runtime.GOOS, home, dataHome)
}

func randomCredential() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", errors.New("secure credential generation failed")
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func credentialPath(dataDirectory string) string {
	return filepath.Join(dataDirectory, "host-credentials.json")
}

func validateCredentials(credentials localCredentials) error {
	if credentials.SchemaVersion != "multivibe-host-credentials-v1" || len(credentials.AdminToken) < 32 || len(credentials.ProxyAPIKey) < 32 {
		return errors.New("the local credential file is invalid")
	}
	return nil
}

func loadOrCreateCredentials(dataDirectory string) (localCredentials, error) {
	if err := os.MkdirAll(dataDirectory, 0o700); err != nil {
		return localCredentials{}, errors.New("the application data directory cannot be created")
	}
	if err := secureHostPrivateDirectory(dataDirectory); err != nil {
		return localCredentials{}, errors.New("the application data directory cannot be protected")
	}
	path := credentialPath(dataDirectory)
	info, err := os.Lstat(path)
	if err == nil {
		if !hostPrivateFile(path, info) || info.Size() > 16*1024 {
			return localCredentials{}, errors.New("the local credential file permissions are invalid")
		}
		file, err := os.Open(path)
		if err != nil {
			return localCredentials{}, errors.New("the local credential file cannot be opened")
		}
		defer file.Close()
		var credentials localCredentials
		decoder := json.NewDecoder(io.LimitReader(file, 16*1024+1))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&credentials) != nil || validateCredentials(credentials) != nil {
			return localCredentials{}, errors.New("the local credential file is invalid")
		}
		var trailing any
		if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
			return localCredentials{}, errors.New("the local credential file is invalid")
		}
		return credentials, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return localCredentials{}, errors.New("the local credential destination cannot be inspected")
	}
	adminToken, err := randomCredential()
	if err != nil {
		return localCredentials{}, err
	}
	proxyAPIKey, err := randomCredential()
	if err != nil {
		return localCredentials{}, err
	}
	credentials := localCredentials{
		SchemaVersion: "multivibe-host-credentials-v1",
		AdminToken:    adminToken,
		ProxyAPIKey:   proxyAPIKey,
	}
	encoded, err := json.Marshal(credentials)
	if err != nil {
		return localCredentials{}, errors.New("the local credential file cannot be encoded")
	}
	temporary, err := os.OpenFile(path+".new", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return localCredentials{}, errors.New("the local credential file cannot be staged")
	}
	removeTemporary := true
	defer func() {
		if removeTemporary {
			_ = os.Remove(path + ".new")
		}
	}()
	if _, err := temporary.Write(append(encoded, '\n')); err != nil || secureHostPrivateFile(path+".new") != nil || temporary.Sync() != nil || temporary.Close() != nil {
		_ = temporary.Close()
		return localCredentials{}, errors.New("the local credential file cannot be committed")
	}
	if err := os.Rename(path+".new", path); err != nil {
		return localCredentials{}, errors.New("the local credential file cannot be committed")
	}
	removeTemporary = false
	return credentials, nil
}

func initializeState() (string, error) {
	directory, err := dataDirectory()
	if err != nil {
		return "", err
	}
	if _, err := loadOrCreateCredentials(directory); err != nil {
		return "", err
	}
	return directory, nil
}

func inheritedEnvironment(name string) string {
	value := os.Getenv(name)
	if strings.IndexByte(value, 0) >= 0 {
		return ""
	}
	return value
}

func hostPort(value string) (string, error) {
	if value == "" {
		return "1455", nil
	}
	port, err := strconv.ParseUint(value, 10, 16)
	if err != nil || port == 0 || strconv.FormatUint(port, 10) != value {
		return "", errors.New("MULTIVIBE_HOST_PORT must be a canonical TCP port")
	}
	return value, nil
}

func hostBindAddress(value string) (string, error) {
	if value == "" {
		return strings.Join([]string{"127", "0", "0", "1"}, "."), nil
	}
	for _, allowed := range []string{"127.0.0.1", "::1", "0.0.0.0", "::"} {
		if value == allowed {
			return value, nil
		}
	}
	return "", errors.New("MULTIVIBE_HOST_BIND must be a literal loopback or wildcard address")
}

func loopbackOrigin(bindAddress, port string) string {
	if bindAddress == "::1" {
		return "http://[::1]:" + port
	}
	return "http://127.0.0.1:" + port
}

func hostPublicBaseURL(value, bindAddress, port string) (string, error) {
	if value == "" {
		if bindAddress == "127.0.0.1" || bindAddress == "::1" {
			return loopbackOrigin(bindAddress, port), nil
		}
		return "", errors.New("MULTIVIBE_HOST_PUBLIC_URL is required when the Host binds outside loopback")
	}
	if strings.TrimSpace(value) != value || strings.IndexByte(value, 0) >= 0 {
		return "", errors.New("MULTIVIBE_HOST_PUBLIC_URL must be a clean HTTP(S) origin")
	}
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" ||
		parsed.User != nil || parsed.Opaque != "" || parsed.RawQuery != "" || parsed.Fragment != "" ||
		(parsed.Path != "" && parsed.Path != "/") || parsed.RawPath != "" || strings.Contains(parsed.Host, "%") {
		return "", errors.New("MULTIVIBE_HOST_PUBLIC_URL must be a clean HTTP(S) origin")
	}
	if parsed.Hostname() == "" || strings.ContainsAny(parsed.Hostname(), "[]") {
		return "", errors.New("MULTIVIBE_HOST_PUBLIC_URL must be a clean HTTP(S) origin")
	}
	publicPort := parsed.Port()
	if publicPort != "" {
		if _, err := hostPort(publicPort); err != nil {
			return "", errors.New("MULTIVIBE_HOST_PUBLIC_URL must use a canonical TCP port")
		}
	}
	canonicalAuthority := parsed.Hostname()
	if strings.Contains(canonicalAuthority, ":") {
		canonicalAuthority = "[" + canonicalAuthority + "]"
	}
	if publicPort != "" {
		canonicalAuthority = net.JoinHostPort(parsed.Hostname(), publicPort)
	}
	if parsed.Host != canonicalAuthority {
		return "", errors.New("MULTIVIBE_HOST_PUBLIC_URL must use a canonical authority")
	}
	return strings.TrimSuffix(value, "/"), nil
}

func coreEnvironment(layout bundleLayout, dataDirectory string, credentials localCredentials, network coreNetworkConfiguration) []string {
	nodeHost, nodePort := network.BindAddress, network.Port
	if runtime.GOOS == "darwin" {
		nodeHost, nodePort = "127.0.0.1", "1456"
	}
	pathValue := "/usr/bin:/bin:/usr/sbin:/sbin"
	if runtime.GOOS == "windows" {
		pathParts := []string{filepath.Dir(layout.Node), filepath.Dir(layout.Updater)}
		if systemRoot := strings.TrimSpace(os.Getenv("SystemRoot")); filepath.IsAbs(systemRoot) {
			pathParts = append(pathParts, filepath.Join(systemRoot, "System32"), systemRoot)
		}
		pathValue = strings.Join(pathParts, string(os.PathListSeparator))
	}
	environment := []string{
		"NODE_ENV=production",
		"APP_VERSION=" + hostApplicationVersion,
		"MODELS_CLIENT_VERSION=" + modelsClientVersion,
		"HOST=" + nodeHost,
		"PORT=" + nodePort,
		"PUBLIC_BASE_URL=" + network.PublicBaseURL,
		"OAUTH_REDIRECT_URI=" + network.PublicBaseURL + "/auth/callback",
		"ADMIN_TOKEN=" + credentials.AdminToken,
		"PROXY_API_KEY=" + credentials.ProxyAPIKey,
		"STORE_PATH=" + filepath.Join(dataDirectory, "accounts.json"),
		"MODULES_PATH=" + filepath.Join(dataDirectory, "modules"),
		"BUNDLED_SECURITY_MODULE_PATH=" + layout.Security,
		"OAUTH_STATE_PATH=" + filepath.Join(dataDirectory, "oauth-state.json"),
		"TRACE_FILE_PATH=" + filepath.Join(dataDirectory, "requests-trace.jsonl"),
		"TRACE_STATS_HISTORY_PATH=" + filepath.Join(dataDirectory, "requests-stats-history.jsonl"),
		"ANONYMOUS_USAGE_STATE_PATH=" + filepath.Join(dataDirectory, "anonymous-usage-state.json"),
		"CODEX_PROJECTS_PATH=" + filepath.Join(dataDirectory, "codex-projects.json"),
		"JOBS_DB_PATH=" + filepath.Join(dataDirectory, "jobs.sqlite"),
		"MULTIVIBE_HOST_APPLICATION=true",
		"TRACE_INCLUDE_BODY=false",
		"TRACE_INCLUDE_HEADERS=false",
		"MULTIVIBE_HOST_DATA_DIR=" + dataDirectory,
		"PATH=" + pathValue,
	}
	if runtime.GOOS == "windows" {
		home, _ := os.UserHomeDir()
		localAppData := strings.TrimSpace(os.Getenv("LOCALAPPDATA"))
		if localAppData == "" {
			localAppData = filepath.Join(home, "AppData", "Local")
		}
		appData := strings.TrimSpace(os.Getenv("APPDATA"))
		if appData == "" {
			appData = filepath.Join(home, "AppData", "Roaming")
		}
		environment = append(environment,
			"APPDATA="+appData,
			"LOCALAPPDATA="+localAppData,
			"TEMP="+filepath.Join(dataDirectory, "tmp"),
			"TMP="+filepath.Join(dataDirectory, "tmp"),
			"USERPROFILE="+home,
		)
		if systemRoot := strings.TrimSpace(os.Getenv("SystemRoot")); filepath.IsAbs(systemRoot) {
			environment = append(environment, "SystemRoot="+systemRoot)
		}
	}
	if runtime.GOOS == "darwin" {
		environment = append(environment, "CONTROL_PLANE_PORT=1456", "MULTIVIBE_CONTROL_PLANE=true")
	}
	if inheritedEnvironment("MULTIVIBE_HOST_CONTAINER") != "true" {
		environment = append(environment, "MULTIVIBE_HOST_UPDATER_BINARY="+layout.Updater)
	}
	for _, name := range []string{"HOME", "LANG", "LC_ALL", "SSL_CERT_DIR", "SSL_CERT_FILE", "TMPDIR", "TZ"} {
		if value := inheritedEnvironment(name); value != "" {
			environment = append(environment, name+"="+value)
		}
	}
	for _, pair := range []struct {
		source      string
		destination string
	}{} {
		if value := inheritedEnvironment(pair.source); value != "" {
			environment = append(environment, pair.destination+"="+value)
		}
	}
	return environment
}

func edgeEnvironment(base []string, network coreNetworkConfiguration, internalToken string) []string {
	environment := append([]string{}, base...)
	environment = append(environment,
		"V1_EDGE_HOST="+network.BindAddress,
		"V1_EDGE_PORT="+network.Port,
		"V1_EDGE_BASE_URL="+network.PublicBaseURL,
		"NODE_CONTROL_PLANE_URL=http://127.0.0.1:1456",
		"TRACE_JOURNAL_MAX_BYTES=67108864",
		"V1_EDGE_INTERNAL_JOB_TOKEN="+internalToken,
	)
	return environment
}

const childShutdownTimeout = 5 * time.Second

func waitForChild(process *os.Process, done <-chan error) {
	select {
	case <-done:
		return
	case <-time.After(childShutdownTimeout):
		_ = process.Kill()
		<-done
	}
}

func signalAndWaitForChild(process *os.Process, done <-chan error, childSignal os.Signal) {
	_ = process.Signal(childSignal)
	waitForChild(process, done)
}

func run() error {
	layout, err := currentLayout()
	if err != nil {
		return err
	}
	if err := validateLayout(layout); err != nil {
		return err
	}
	if runtime.GOOS == "darwin" {
		scheduler := exec.Command(layout.Updater, "schedule")
		if output, err := scheduler.CombinedOutput(); err != nil {
			fmt.Fprintf(os.Stderr, "Host update scheduler unavailable: %s (%v)\n", output, err)
		}
	}
	data, err := dataDirectory()
	if err != nil {
		return err
	}
	credentials, err := loadOrCreateCredentials(data)
	if err != nil {
		return err
	}
	port, err := hostPort(strings.TrimSpace(os.Getenv("MULTIVIBE_HOST_PORT")))
	if err != nil {
		return err
	}
	bindAddress, err := hostBindAddress(strings.TrimSpace(os.Getenv("MULTIVIBE_HOST_BIND")))
	if err != nil {
		return err
	}
	publicBaseURL, err := hostPublicBaseURL(strings.TrimSpace(os.Getenv("MULTIVIBE_HOST_PUBLIC_URL")), bindAddress, port)
	if err != nil {
		return err
	}
	entry := filepath.Join(layout.App, "dist", "server.js")
	instrument := filepath.Join(layout.App, "dist", "instrument.js")
	arguments := []string{layout.Node, "--import", instrument, entry}
	if err := os.Chdir(layout.App); err != nil {
		return errors.New("the bundled application directory is unavailable")
	}
	network := coreNetworkConfiguration{BindAddress: bindAddress, Port: port, PublicBaseURL: publicBaseURL}
	internalToken, err := randomCredential()
	if err != nil {
		return err
	}
	baseEnvironment := coreEnvironment(layout, data, credentials, network)
	if runtime.GOOS == "linux" {
		return syscall.Exec(layout.Node, arguments, baseEnvironment)
	}
	if runtime.GOOS == "windows" {
		node := exec.Command(layout.Node, arguments[1:]...)
		node.Dir = layout.App
		node.Env = baseEnvironment
		node.Stdout, node.Stderr = os.Stdout, os.Stderr
		return node.Run()
	}
	baseEnvironment = append(baseEnvironment, "V1_EDGE_INTERNAL_JOB_TOKEN="+internalToken)
	node := exec.Command(layout.Node, arguments[1:]...)
	node.Dir = layout.App
	node.Env = baseEnvironment
	node.Stdout, node.Stderr = os.Stdout, os.Stderr
	edge := exec.Command(layout.Edge)
	edge.Dir = layout.App
	edge.Env = edgeEnvironment(baseEnvironment, network, internalToken)
	edge.Stdout, edge.Stderr = os.Stdout, os.Stderr
	if err := node.Start(); err != nil {
		return errors.New("the Node control plane could not be started")
	}
	nodeDone := make(chan error, 1)
	go func() { nodeDone <- node.Wait() }()
	if err := edge.Start(); err != nil {
		signalAndWaitForChild(node.Process, nodeDone, syscall.SIGTERM)
		return errors.New("the Rust v1 edge could not be started")
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(stop)
	edgeDone := make(chan error, 1)
	go func() { edgeDone <- edge.Wait() }()
	select {
	case signal := <-stop:
		_ = node.Process.Signal(signal)
		_ = edge.Process.Signal(signal)
		waitForChild(node.Process, nodeDone)
		waitForChild(edge.Process, edgeDone)
		return nil
	case err := <-edgeDone:
		signalAndWaitForChild(node.Process, nodeDone, syscall.SIGTERM)
		return fmt.Errorf("Rust v1 edge stopped: %w", err)
	case err := <-nodeDone:
		signalAndWaitForChild(edge.Process, edgeDone, syscall.SIGTERM)
		return fmt.Errorf("Node control plane stopped: %w", err)
	}
}
