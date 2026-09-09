import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stylesheet = await readFile(
  new URL("../src/components/tabs/ModelsTab.css", import.meta.url),
  "utf8",
);

function firstRule(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = stylesheet.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `Missing ${selector} rule`);
  return match[1];
}

test("the desktop model library has one shared vertical scroll surface", () => {
  const workspace = firstRule(".app-shell-models .workspace-content");
  assert.match(workspace, /flex:\s*1 1 0/);
  assert.match(workspace, /overflow:\s*hidden/);
  assert.match(firstRule(".models-catalog"), /overflow-y:\s*auto/);

  for (const selector of [".models-sidebar", ".models-results"]) {
    const rule = firstRule(selector);
    assert.doesNotMatch(rule, /overflow(?:-y)?:\s*(?:auto|scroll)/);
    assert.doesNotMatch(rule, /height:\s*100%/);
  }
});
