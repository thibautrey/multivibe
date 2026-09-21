import assert from "node:assert/strict";
import test from "node:test";

import { responsesToChatCompletionsPayload } from "./payloads.js";

test("keeps tool output images as image parts instead of base64 tool text", () => {
  const base64 = "A".repeat(4096);
  const converted = responsesToChatCompletionsPayload({
    model: "deepseek/deepseek-flash",
    stream: true,
    input: [
      { type: "function_call", call_id: "call-img", name: "view_image", arguments: "{}" },
      {
        type: "function_call_output",
        call_id: "call-img",
        output: [{ type: "input_image", image_url: `data:image/png;base64,${base64}` }],
      },
    ],
  });

  const tool = converted.messages[1];
  assert.equal(tool.role, "tool");
  assert.equal(tool.tool_call_id, "call-img");
  assert.equal(tool.content, "");
  assert.ok(!JSON.stringify(tool).includes(base64));

  const followUp = converted.messages[2];
  assert.equal(followUp.role, "user");
  assert.equal(followUp.content[1].type, "image_url");
  assert.ok(followUp.content[1].image_url.url.endsWith(base64));
});

test("keeps text-only tool output in a single tool message", () => {
  const converted = responsesToChatCompletionsPayload({
    model: "deepseek/deepseek-flash",
    stream: true,
    input: [
      { type: "function_call", call_id: "call-1", name: "run", arguments: "{}" },
      { type: "function_call_output", call_id: "call-1", output: [{ type: "text", text: "ok" }] },
      { type: "function_call", call_id: "call-2", name: "run", arguments: "{}" },
      { type: "function_call_output", call_id: "call-2", output: "plain text" },
    ],
  });

  assert.equal(converted.messages[1].content, "ok");
  assert.equal(converted.messages[3].content, "plain text");
  assert.equal(converted.messages.length, 4);
});

test("keeps custom tool call output images as image parts", () => {
  const base64 = "B".repeat(1024);
  const converted = responsesToChatCompletionsPayload({
    model: "deepseek/deepseek-flash",
    stream: true,
    input: [
      {
        type: "custom_tool_call_output",
        call_id: "call-custom",
        output: [{ type: "input_image", image_url: `data:image/png;base64,${base64}` }],
      },
    ],
  });

  assert.equal(converted.messages[0].role, "tool");
  assert.equal(converted.messages[0].content, "");
  assert.equal(converted.messages[1].role, "user");
  assert.equal(converted.messages[1].content[1].type, "image_url");
});

test("repairs a pending tool turn that lost its reasoning marker", () => {
  const body = {
    model: "deepseek/deepseek-flash",
    stream: true,
    input: [
      { type: "message", role: "user", content: "Have you fixed it?" },
      { type: "function_call", call_id: "call-1", name: "exec_command", arguments: "{}" },
      { type: "function_call_output", call_id: "call-1", output: "merge ok" },
      { type: "message", role: "assistant", content: "Merged. Running tests." },
      { type: "function_call", call_id: "call-2", name: "exec_command", arguments: "{}" },
      { type: "function_call_output", call_id: "call-2", output: "tests failed" },
    ],
  };

  const plain = responsesToChatCompletionsPayload(body);
  assert.ok(!JSON.stringify(plain.messages).includes("reasoning_content"));

  const repaired = responsesToChatCompletionsPayload(body, {
    ensureReasoningContinuation: true,
  });
  for (const message of repaired.messages) {
    if (message.role === "assistant") {
      assert.ok(typeof message.reasoning_content === "string" && message.reasoning_content);
    }
  }

  const closed = responsesToChatCompletionsPayload(
    {
      model: "deepseek/deepseek-flash",
      stream: true,
      input: [
        { type: "function_call", call_id: "call-1", name: "exec_command", arguments: "{}" },
        { type: "function_call_output", call_id: "call-1", output: "ok" },
        { type: "message", role: "user", content: "thanks" },
      ],
    },
    { ensureReasoningContinuation: true },
  );
  assert.equal(closed.messages[0].reasoning_content, undefined);
});

test("repairs malformed tool arguments before forwarding", () => {
  const converted = responsesToChatCompletionsPayload({
    model: "deepseek/deepseek-flash",
    stream: true,
    input: [
      {
        type: "function_call",
        call_id: "call-1",
        name: "exec_command",
        arguments: '{"zsh": zsh}',
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "failed to parse function arguments",
      },
    ],
  });
  assert.equal(converted.messages[0].tool_calls[0].function.arguments, "{}");

  const preserved = responsesToChatCompletionsPayload({
    model: "deepseek/deepseek-flash",
    stream: true,
    input: [
      { type: "function_call", call_id: "call-1", name: "exec_command", arguments: '{"cmd":"ls"}' },
      { type: "function_call_output", call_id: "call-1", output: "ok" },
    ],
  });
  assert.equal(preserved.messages[0].tool_calls[0].function.arguments, '{"cmd":"ls"}');

  const objectArguments = responsesToChatCompletionsPayload({
    model: "deepseek/deepseek-flash",
    stream: true,
    input: [
      { type: "function_call", call_id: "call-1", name: "exec_command", arguments: { cmd: "ls" } },
      { type: "function_call_output", call_id: "call-1", output: "ok" },
    ],
  });
  assert.doesNotThrow(() =>
    JSON.parse(objectArguments.messages[0].tool_calls[0].function.arguments),
  );
});
