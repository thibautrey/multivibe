import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const refresh = await readFile(new URL("../../src/workspace-refresh.css", import.meta.url), "utf8");
const base = await readFile(new URL("../../src/host/styles.css", import.meta.url), "utf8");
const component = await readFile(new URL("../../src/host/HostHarnessCarousel.tsx", import.meta.url), "utf8");

test("coding tools stay in one horizontally scrollable row on every viewport", () => {
  const rules = [...refresh.matchAll(/\.host-harness-rail\s*\{([^}]+)\}/g)].map((match) => match[1]);
  assert.equal(rules.length, 1, "No responsive grid override should replace the scrolling row");
  assert.match(rules[0], /display:\s*flex/);
  assert.match(rules[0], /flex-wrap:\s*nowrap/);
  assert.match(rules[0], /overflow-x:\s*auto/);
  assert.match(refresh, /\.host-harness-browser\s*\{\s*min-width:\s*0/);
  assert.match(base, /flex:\s*0 0 292px/);
  assert.match(base, /flex-basis:\s*min\(82vw, 280px\)/);
});

test("the coding tools scroll region is named and keyboard focusable", () => {
  assert.match(component, /className="host-harness-rail" role="region" tabIndex=\{0\} aria-label="Detected coding tools"/);
  assert.match(refresh, /\.host-harness-rail:focus-visible\s*\{[^}]*outline:/);
});
