import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { optimizeCodexPrefix } from "./codex-prefix.js";
import { normalizeResponsesPayload, responsesToChatCompletionsPayload } from "./payloads.js";

const fixture = JSON.parse(readFileSync(new URL("../../test-fixtures/codex-prefix.json", import.meta.url), "utf8"));

test("Codex prefix is deterministic, idempotent and preserves caller history and fields", () => {
  const source = structuredClone(fixture.input);
  const result = optimizeCodexPrefix(source);
  assert.deepEqual(result, fixture.expected);
  assert.deepEqual(source, fixture.input);
  assert.deepEqual(optimizeCodexPrefix(result), result);
  assert.deepEqual(result.input.slice(-4), source.input.slice(-4));
});

test("unknown instructions, identities, cache boundaries and incremental requests stay opaque", () => {
  const mutations = [
    (b: any) => { b.previous_response_id = "response-1"; },
    (b: any) => { b.conversation = "conversation-1"; },
    (b: any) => { b.input[1].id = "message-1"; },
    (b: any) => { b.input[1].content[0].prompt_cache_breakpoint = { mode: "explicit" }; },
    (b: any) => { b.input[1].content.push({ type: "input_text", text: "Unknown overriding instruction." }); },
    (b: any) => { b.input[1].content.push({ type: "input_image", image_url: "opaque" }); },
    (b: any) => { b.input = [{ role: "user", content: "<app-context>literal user text" }, b.input[1]]; },
  ];
  for (const mutate of mutations) {
    const source = structuredClone(fixture.input);
    mutate(source);
    assert.equal(optimizeCodexPrefix(source), source);
  }
  assert.equal(optimizeCodexPrefix(null), null);
});

test("Responses and Chat projections both retain the optimized initial order", () => {
  assert.deepEqual(normalizeResponsesPayload(fixture.input).input, fixture.expected.input);
  const chat = responsesToChatCompletionsPayload(fixture.input);
  // A strict chat template accepts one leading system message, so the Chat
  // projection folds the optimized run into it without losing the priority.
  assert.equal(chat.messages.filter((m: any) => m.role === "system").length, 1);
  const merged = chat.messages[0].content;
  const blocks = fixture.expected.input
    .filter((m: any) => m.role === "developer")
    .map((m: any) =>
      typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text).join(""));
  let cursor = 0;
  for (const block of blocks) {
    const at: number = merged.indexOf(block, cursor);
    assert.ok(at >= 0, `Chat projection lost ${block.slice(0, 32)}`);
    cursor = at + block.length;
  }
});

test("Chat projection preserves instruction priority even when canonicalization is ineligible", () => {
  const chat = responsesToChatCompletionsPayload({ input: [
    { role: "system", content: "System instruction" },
    { role: "developer", content: "Developer instruction" },
    { role: "user", content: "User request" },
  ] });
  assert.deepEqual(chat.messages, [
    { role: "system", content: "System instruction\n\nDeveloper instruction" },
    { role: "user", content: "User request" },
  ]);
});
