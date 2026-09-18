import assert from "node:assert/strict";
import test from "node:test";
import { createGoogleModel } from "./google.js";

test("google generate sends native contents and maps usage metadata", async () => {
  let request: { url: string; headers: Headers; body: any } | undefined;
  const model = createGoogleModel({
    modelId: "gemini-2.5-flash",
    apiKey: "google-key",
    fetch: async (input, init) => {
      request = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
      return Response.json({
        candidates: [{
          content: { role: "model", parts: [{ text: "Hi" }, { thought: true, text: "pondering" }, { functionCall: { name: "lookup", args: { q: "x" } } }] },
          finishReason: "STOP",
        }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, cachedContentTokenCount: 1, thoughtsTokenCount: 3, totalTokenCount: 10 },
      });
    },
  });
  const result = await model.doGenerate({
    prompt: [
      { role: "system", content: "Be nice" },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: { q: "old" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call_1", toolName: "lookup", output: { type: "text", value: "old result" } }] },
    ],
    tools: [{ type: "function", name: "lookup", description: "Look up", inputSchema: { type: "object" } }],
    toolChoice: { type: "tool", toolName: "lookup" },
    maxOutputTokens: 128,
    temperature: 0.1,
    responseFormat: { type: "json", schema: { type: "object" } },
  });
  assert.ok(request);
  assert.equal(request.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
  assert.equal(request.headers.get("x-goog-api-key"), "google-key");
  assert.deepEqual(request.body.systemInstruction, { parts: [{ text: "Be nice" }] });
  assert.equal(request.body.contents[0].parts[0].text, "Hello");
  assert.equal(request.body.contents[1].parts[0].functionCall.name, "lookup");
  assert.equal(request.body.contents[2].parts[0].functionResponse.name, "lookup");
  assert.equal(request.body.generationConfig.maxOutputTokens, 128);
  assert.equal(request.body.generationConfig.responseMimeType, "application/json");
  assert.equal(request.body.tools[0].functionDeclarations[0].name, "lookup");
  assert.deepEqual(request.body.toolConfig.functionCallingConfig.allowedFunctionNames, ["lookup"]);
  assert.deepEqual(result.content.map((part) => part.type), ["text", "reasoning", "tool-call"]);
  assert.equal(result.finishReason.unified, "stop");
  assert.equal(result.usage.inputTokens.total, 5);
  assert.equal(result.usage.inputTokens.cacheRead, 1);
  assert.equal(result.usage.outputTokens.total, 5);
  assert.equal(result.usage.outputTokens.reasoning, 3);
});

test("google stream emits incremental text and preserves measured usage", async () => {
  const chunks = [
    { candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] }, finishReason: null }] },
    { candidates: [{ content: { role: "model", parts: [{ text: "lo" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 } },
  ];
  let url = "";
  const model = createGoogleModel({
    modelId: "gemini-2.5-flash", apiKey: "google-key",
    fetch: async (input) => {
      url = String(input);
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  const { stream } = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] });
  const parts: any[] = [];
  for await (const part of stream) parts.push(part);
  assert.match(url, /:streamGenerateContent\?alt=sse$/);
  assert.equal(parts.filter((part) => part.type === "text-delta").map((part) => part.delta).join(""), "Hello");
  const finish = parts.find((part) => part.type === "finish");
  assert.equal(finish.finishReason.unified, "stop");
  assert.equal(finish.usage.inputTokens.total, 4);
  assert.equal(finish.usage.outputTokens.total, 2);
});

test("google stream resolves function calls into complete tool calls", async () => {
  const chunks = [
    { candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "call_g", name: "lookup", args: { q: "x" } } }] }, finishReason: "STOP" }] },
  ];
  const model = createGoogleModel({
    modelId: "gemini-2.5-flash", apiKey: "k",
    fetch: async () => new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")),
  });
  const { stream } = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] });
  const parts: any[] = [];
  for await (const part of stream) parts.push(part);
  assert.ok(parts.some((part) => part.type === "tool-input-start" && part.id === "call_g" && part.toolName === "lookup"));
  assert.deepEqual(parts.find((part) => part.type === "tool-call").input, { q: "x" });
});
