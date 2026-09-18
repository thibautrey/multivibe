import assert from "node:assert/strict";
import test from "node:test";
import { createAnthropicModel } from "./anthropic.js";

test("anthropic generate sends messages API fields and keeps raw usage", async () => {
  let request: { url: string; headers: Headers; body: any } | undefined;
  const model = createAnthropicModel({
    modelId: "claude-sonnet-4-6",
    apiKey: "anthropic-key",
    fetch: async (input, init) => {
      request = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
      return Response.json({
        id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Hi" }, { type: "thinking", thinking: "hmm", signature: "sig" }, { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } }],
        stop_reason: "tool_use", stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 4, cache_creation_input_tokens: 2, cache_read_input_tokens: 1, output_tokens_details: { thinking_tokens: 3 } },
      });
    },
  });
  const result = await model.doGenerate({
    prompt: [
      { role: "system", content: "Be nice" },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "toolu_0", toolName: "lookup", input: { q: "old" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "toolu_0", toolName: "lookup", output: { type: "text", value: "old" } }] },
    ],
    tools: [{ type: "function", name: "lookup", description: "Look up", inputSchema: { type: "object" } }],
    maxOutputTokens: 64,
    temperature: 0.3,
  });
  assert.ok(request);
  assert.equal(request.url, "https://api.anthropic.com/v1/messages");
  assert.equal(request.headers.get("x-api-key"), "anthropic-key");
  assert.equal(request.headers.get("anthropic-version"), "2023-06-01");
  assert.equal(request.body.model, "claude-sonnet-4-6");
  assert.equal(request.body.max_tokens, 64);
  assert.equal(request.body.system, "Be nice");
  assert.equal(request.body.messages[0].content[0].text, "Hello");
  assert.equal(request.body.messages[1].content[0].type, "tool_use");
  assert.equal(request.body.messages[2].content[0].type, "tool_result");
  assert.equal(request.body.tools[0].input_schema.type, "object");
  assert.deepEqual(result.content.map((part) => part.type), ["text", "reasoning", "tool-call"]);
  assert.equal(result.finishReason.unified, "tool-calls");
  assert.equal(result.usage.inputTokens.total, 8);
  assert.equal(result.usage.inputTokens.cacheRead, 1);
  assert.equal(result.usage.inputTokens.cacheWrite, 2);
  assert.equal(result.usage.outputTokens.total, 4);
  assert.equal(result.usage.outputTokens.reasoning, 3);
  assert.equal((result.usage.raw as any).cache_creation_input_tokens, 2);
});

test("anthropic stream assembles thinking, text and tool input blocks", async () => {
  const events = [
    { type: "message_start", message: { id: "msg_2", model: "claude-sonnet-4-6", usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_2", name: "lookup", input: {} } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"q":' } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"x"}' } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
    { type: "message_stop" },
  ];
  const model = createAnthropicModel({
    modelId: "claude-sonnet-4-6", apiKey: "k",
    fetch: async () => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }),
  });
  const { stream } = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] });
  const parts: any[] = [];
  for await (const part of stream) parts.push(part);
  assert.equal(parts.find((part) => part.type === "reasoning-delta")?.delta, "plan");
  assert.equal(parts.find((part) => part.type === "text-delta")?.delta, "Answer");
  assert.equal(parts.find((part) => part.type === "tool-input-start")?.toolName, "lookup");
  assert.equal(parts.filter((part) => part.type === "tool-input-delta").map((part) => part.delta).join(""), '{"q":"x"}');
  const toolCall = parts.find((part) => part.type === "tool-call");
  assert.deepEqual(toolCall.input, { q: "x" });
  const finish = parts.find((part) => part.type === "finish");
  assert.equal(finish.finishReason.unified, "tool-calls");
  assert.equal(finish.usage.inputTokens.total, 5);
  assert.equal(finish.usage.outputTokens.total, 9);
});
