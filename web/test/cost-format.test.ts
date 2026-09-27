import assert from "node:assert/strict";
import test from "node:test";
import { usd, pct, formatTokenCount, formatTokenRate, formatLatency, sumMeasured } from "../../packages/ui/src/lib/ui";

test("formats compact USD values with the unit after the magnitude", () => {
  assert.equal(usd(1_000), "1K $US");
  assert.equal(usd(1_000_000), "1M $US");
  assert.match(usd(0.25), /^0[.,]25 \$US$/);
});

test("missing measurements stay unavailable while measured zero stays zero", () => {
  for (const missing of [null, undefined, NaN, Infinity]) {
    for (const format of [usd, pct, formatTokenCount, formatTokenRate, formatLatency]) {
      assert.equal(format(missing), "Unavailable");
    }
  }
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenRate(0), "0 tok/s");
  assert.equal(formatLatency(0), "0ms");
  assert.equal(pct(0), "0.0%");
  assert.match(usd(0), /^0[.,]00 \$US$/);
  assert.equal(sumMeasured([4, null, 2]), null);
  assert.equal(sumMeasured([4, 0, 2]), 6);
});
