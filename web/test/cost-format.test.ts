import assert from "node:assert/strict";
import test from "node:test";
import { usd } from "../src/lib/ui";

test("formats compact USD values with the unit after the magnitude", () => {
  assert.equal(usd(1_000), "1K $US");
  assert.equal(usd(1_000_000), "1M $US");
  assert.match(usd(0.25), /^0[.,]25 \$US$/);
});
