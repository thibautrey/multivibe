import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const accountsTabSource = await readFile(
  new URL("../src/components/tabs/AccountsTab.tsx", import.meta.url),
  "utf8",
);
const macOSMenuDirectory = new URL("../../packaging/macos/", import.meta.url);
const macOSMenuSource = (await Promise.all(
  (await readdir(macOSMenuDirectory))
    .filter((name) => name.endsWith(".swift"))
    .sort()
    .map((name) => readFile(new URL(name, macOSMenuDirectory), "utf8")),
)).join("\n");
const linuxMenuSource = await readFile(
  new URL("../../host/menu/menu.c", import.meta.url),
  "utf8",
);
const windowsMenuSource = await readFile(
  new URL("../../host/menu/win32_menu_windows.go", import.meta.url),
  "utf8",
);
const linuxMenuAppSource = await readFile(
  new URL("../../host/menu/main.go", import.meta.url),
  "utf8",
);
const windowsMenuAppSource = await readFile(
  new URL("../../host/menu/main_windows.go", import.meta.url),
  "utf8",
);

test("the cross-platform Host dashboard describes local hardware as a worker", () => {
  assert.match(accountsTabSource, /Connect this worker to MultiVibe Cloud/);
  assert.match(accountsTabSource, /http:\/\/worker\.local:8000\/health/);
  assert.doesNotMatch(accountsTabSource, /Connect this Mac|http:\/\/mac\.local/);
});

test("every Host enrollment UI describes local hardware as a worker", () => {
  for (const source of [macOSMenuSource, linuxMenuSource, windowsMenuSource]) {
    assert.match(source, /Add this worker to MultiVibe Cloud\?/);
    assert.match(source, /register this worker's public device identity/);
    assert.match(source, /settings stay on this worker/);
    assert.doesNotMatch(source, /Add this (?:Mac|Linux host|Windows host)/);
  }
  assert.match(macOSMenuSource, /This worker is connected/);
  assert.doesNotMatch(macOSMenuSource, /This Mac|this Mac/);
  for (const source of [linuxMenuAppSource, windowsMenuAppSource]) {
    assert.match(source, /This worker is connected/);
    assert.match(source, /This worker could not be connected/);
    assert.doesNotMatch(source, /This (?:Linux|Windows) host/);
  }
});
