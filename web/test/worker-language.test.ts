import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const accountsTabSource = await readFile(
  new URL("../src/components/tabs/AccountsTab.tsx", import.meta.url),
  "utf8",
);

test("the cross-platform Host dashboard describes local hardware as a worker", () => {
  assert.match(accountsTabSource, /Connect this worker to MultiVibe Cloud/);
  assert.match(accountsTabSource, /http:\/\/worker\.local:8000\/health/);
  assert.doesNotMatch(accountsTabSource, /Connect this Mac|http:\/\/mac\.local/);
});
