import assert from "node:assert/strict";
import test from "node:test";
import { validateChatToolContract } from "./tool-contract.js";

test("chat bridge rejects capability loss and dangling choices", () => {
  for (const body of [
    { tools: [{ type: "custom", name: "exec" }] },
    { tools: [{ type: "web_search_preview" }] },
    { tools: [], tool_choice: "required" },
    { tools: [{ type: "function", name: "lookup" }], tool_choice: { type: "function", name: "missing" } },
  ]) assert.ok(validateChatToolContract(body));
  assert.equal(validateChatToolContract({ tools: [{ type: "function", name: "lookup" }], tool_choice: "required" }), undefined);
});
