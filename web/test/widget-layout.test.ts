import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeWidgets, moveWidget } from "../src/lib/widgetLayout.js";

const catalogue = [{ id: "health", required: true }, { id: "cost" }, { id: "requests" }];
test("required widgets survive hidden preferences and new widgets appear", () => {
  assert.deepEqual(normalizeWidgets(catalogue, [{ id: "cost", visible: false, size: "large" }, { id: "health", visible: false, size: "medium" }]), [
    { id: "cost", visible: false, size: "large" }, { id: "health", visible: true, size: "medium" }, { id: "requests", visible: true, size: "small" },
  ]);
});
test("corrupt and obsolete preferences cannot remove the catalogue or duplicate widgets", () => {
  assert.equal(normalizeWidgets(catalogue, { broken: true }).length, 3);
  assert.deepEqual(normalizeWidgets(catalogue, [null, 1, { id: "deleted" }, { id: "cost", size: "huge" }, { id: "cost" }]).map(({ id, size }) => [id, size]), [["cost", "small"], ["health", "small"], ["requests", "small"]]);
});
test("reordering preserves hidden widgets, sizes and the original layout", () => {
  const original = normalizeWidgets(catalogue, [{ id: "cost", visible: false, size: "large" }]);
  const moved = moveWidget(original, "requests", "cost");
  assert.deepEqual(moved.map((item) => item.id), ["requests", "cost", "health"]);
  assert.equal(moved[1].visible, false);
  assert.equal(moved[1].size, "large");
  assert.equal(original[0].id, "cost");
  assert.equal(moveWidget(original, "missing", "health"), original);
});
