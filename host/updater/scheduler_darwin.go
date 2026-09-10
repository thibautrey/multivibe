package main

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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
	// Never unload a running updater: it may currently be replacing the bundle.
	if exec.Command("/bin/launchctl", "print", service).Run() == nil {
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
	if _, err := temporary.Write(schedulerPlist(executable, data)); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporary.Name(), path); err != nil {
		return err
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
