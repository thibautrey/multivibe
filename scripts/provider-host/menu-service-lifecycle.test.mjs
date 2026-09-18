import assert from "node:assert/strict";
import test from "node:test";
import { readMacOSMenuSourceSync } from "./macos-menu-sources.mjs";

const source = readMacOSMenuSourceSync();

test("macOS menu quit stops the background Host service", () => {
  assert.match(source, /func stopHostService\(\)[\s\S]*runLaunchctl\(\["bootout", hostLaunchAgentService\]\)/u);
  assert.match(source, /@objc func quitApplication\(\) \{\s*stopHostService\(\)\s*NSApplication\.shared\.terminate/u);
});

test("macOS launch-at-login preference controls both UI and Host service", () => {
  assert.match(source, /import ServiceManagement/u);
  assert.match(source, /SMAppService\.mainApp\.register\(\)/u);
  assert.match(source, /SMAppService\.mainApp\.unregister\(\)/u);
  assert.match(source, /runLaunchctl\(\["disable", hostLaunchAgentService\]\)/u);
  assert.match(source, /runLaunchctl\(\["enable", hostLaunchAgentService\]\)/u);
  assert.match(source, /synchronizeLoginItem\(\)[\s\S]*render\(\)[\s\S]*ensureServiceIsRunning\(\)/u);
});
