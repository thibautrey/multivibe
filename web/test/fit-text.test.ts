import assert from "node:assert/strict";
import { test } from "node:test";
import { fitFontSize } from "../../packages/ui/src/lib/fitText.js";

test("text that already fits keeps the stylesheet font size", () => {
  assert.equal(fitFontSize({ textWidth: 120, availableWidth: 200, fontSize: 36, minFontSize: 14 }), 36);
});

test("overflowing text is scaled down proportionally to fit", () => {
  assert.equal(fitFontSize({ textWidth: 400, availableWidth: 200, fontSize: 36, minFontSize: 14 }), 18);
});

test("the font size never drops below the floor or grows above the stylesheet size", () => {
  assert.equal(fitFontSize({ textWidth: 4000, availableWidth: 200, fontSize: 36, minFontSize: 14 }), 14);
  assert.equal(fitFontSize({ textWidth: 40, availableWidth: 200, fontSize: 10, minFontSize: 14 }), 10);
});

test("unmeasured boxes leave the font size untouched", () => {
  assert.equal(fitFontSize({ textWidth: 0, availableWidth: 0, fontSize: 36, minFontSize: 14 }), 36);
  assert.equal(fitFontSize({ textWidth: 400, availableWidth: 0, fontSize: 36, minFontSize: 14 }), 36);
});
