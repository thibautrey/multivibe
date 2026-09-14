package main

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const updateServiceLabel = "cloud.multivibe.host.update"

func installedMacApplication() string {
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Dir(filepath.Dir(filepath.Dir(executable)))
}

func schedulerPlist(executable, data string) []byte {
	escape := func(value string) string {
		var b bytes.Buffer
		_ = xml.EscapeText(&b, []byte(value))
		return b.String()
	}
	return []byte(fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>%s</string>
<key>ProgramArguments</key><array><string>%s</string><string>auto</string></array>
<key>EnvironmentVariables</key><dict><key>MULTIVIBE_HOST_DATA_DIR</key><string>%s</string><key>MULTIVIBE_CONTROL_PLANE_PORT</key><string>1456</string></dict>
<key>StartInterval</key><integer>60</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardErrorPath</key><string>%s</string>
</dict></plist>
`, updateServiceLabel, escape(executable), escape(data), escape(filepath.Join(data, "host-update-error.log"))))
}

func ensureScheduler() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	application := installedMacApplication()
	if application != "/Applications/MultiVibe Host.app" && application != filepath.Join(home, "Applications", "MultiVibe Host.app") {
		return errors.New("move MultiVibe Host into Applications to enable background updates")
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	data, err := defaultDataDirectory()
	if err != nil {
		return err
	}
	directory := filepath.Join(home, "Library", "LaunchAgents")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	path := filepath.Join(directory, updateServiceLabel+".plist")
	service := fmt.Sprintf("gui/%d/%s", os.Getuid(), updateServiceLabel)
	// Serialize reconciliation with installation. Never boot out an updater that
	// owns the mutation lock, including one currently replacing this bundle.
	store, err := openStateStore()
	if err != nil {
		return err
	}
	unlock, err := store.lock()
	if err != nil {
		return err
	}
	defer unlock()
	desired := schedulerPlist(executable, data)
	loaded, printErr := exec.Command("/bin/launchctl", "print", service).Output()
	existing, _ := os.ReadFile(path)
	if printErr == nil && schedulerMatches(existing, desired, string(loaded), executable) {
		return nil
	}
	if info, err := os.Lstat(path); err == nil && !updaterPrivateFile(path, info) {
		return errors.New("the update LaunchAgent file is unsafe")
	}
	temporary, err := os.CreateTemp(directory, ".multivibe-update-*")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	if _, err := temporary.Write(desired); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporary.Name(), path); err != nil {
		return err
	}
	if printErr == nil {
		if err := exec.Command("/bin/launchctl", "bootout", service).Run(); err != nil {
			return errors.New("the outdated background update service could not be unloaded")
		}
	}
	domain := fmt.Sprintf("gui/%d", os.Getuid())
	if err := exec.Command("/bin/launchctl", "enable", service).Run(); err != nil {
		return err
	}
	if err := exec.Command("/bin/launchctl", "bootstrap", domain, path).Run(); err != nil {
		return errors.New("the background update service could not be loaded")
	}
	return nil
}

func wakeScheduler() error {
	service := fmt.Sprintf("gui/%d/%s", os.Getuid(), updateServiceLabel)
	if err := exec.Command("/bin/launchctl", "kickstart", service).Run(); err != nil {
		return errors.New("the background update service could not be started")
	}
	return nil
}

// The plist on disk may have been replaced while launchd retained its previous
// definition during an automatic install. Check the loaded interval too.
func schedulerMatches(existing, desired []byte, loaded, executable string) bool {
	return bytes.Equal(existing, desired) &&
		strings.Contains(loaded, "run interval = 60 seconds") &&
		strings.Contains(loaded, "program = "+executable+"\n")
}
