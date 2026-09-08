import assert from "node:assert/strict";
import test from "node:test";
import { createAutomaticRouter, automaticRouterManifest } from "./automatic-router.js";
import { inspectModuleConversation } from "./module-conversation.js";
import type { ModuleContext } from "./module-sdk.js";

const body = { model: "original", messages: [{ role: "user", content: "Explain addition" }] };
function setup() {
  let calls = 0;
  let reply = '{"difficulty":"easy"}';
  const context: ModuleContext = {
    requestId: "r", application: "app", route: "/chat/completions", transport: "http", signal: new AbortController().signal,
    settings: { ...automaticRouterManifest.defaultSettings, classifierModel: "classifier", economyModel: "cheap", balancedModel: "mid", advancedModel: "big" },
    conversation: inspectModuleConversation(body, { "x-multivibe-conversation-mode": "one-off" }),
    log: { info() {}, warn() {}, error() {} },
    services: {
      listModels: async () => ["classifier", "cheap", "mid", "big", "original"].map((id) => ({ id, metadata: { supports_tools: true, context_window: 100_000 } })),
      complete: async () => { calls++; return reply; },
    },
  };
  const hook = createAutomaticRouter()["request.received"]!;
  return { context, hook, calls: () => calls, reply: (value: string) => { reply = value; } };
}
test("classifier selects all difficulty tiers without mutating the original payload", async () => {
  const s = setup();
  for (const [difficulty, model] of [["easy", "cheap"], ["medium", "mid"], ["hard", "big"]]) {
    s.reply(JSON.stringify({ difficulty }));
    assert.deepEqual(await s.hook(body, s.context), { action: "replace", value: { ...body, model } });
    assert.equal(body.model, "original");
  }
});
test("ongoing tasks classify once and retain the model including stateful continuations", async () => {
  const s = setup();
  s.context.conversation = inspectModuleConversation(body, { "x-multivibe-conversation-mode": "multi-turn" }, "session");
  await s.hook(body, s.context);
  s.reply('{"difficulty":"hard"}');
  const continuation = { ...body, previous_response_id: "resp_1" };
  s.context.conversation = inspectModuleConversation(continuation, {}, "session");
  assert.deepEqual(await s.hook(continuation, s.context), { action: "replace", value: { ...continuation, model: "cheap" } });
  assert.equal(s.calls(), 1);
  s.context.application = "another-app";
  assert.deepEqual(await s.hook(continuation, s.context), { action: "continue" });
});
test("unknown history, absent session, recursive calls, and compact requests remain untouched", async () => {
  const s = setup();
  for (const conversation of [inspectModuleConversation(body, {}), inspectModuleConversation({ ...body, previous_response_id: "old" }, {}, "new"), inspectModuleConversation({ ...body, messages: [{ role: "assistant", content: "old" }] }, {}, "new")]) {
    s.context.conversation = conversation;
    assert.deepEqual(await s.hook(body, s.context), { action: "continue" });
  }
  s.context.conversation = inspectModuleConversation(body, { "x-multivibe-conversation-mode": "one-off" });
  s.context.internal = true;
  assert.deepEqual(await s.hook(body, s.context), { action: "continue" });
  s.context.internal = false; s.context.route = "/responses/compact";
  assert.deepEqual(await s.hook(body, s.context), { action: "continue" });
  assert.equal(s.calls(), 0);
});
test("malformed, unavailable, incompatible, scoped and failed classification safely retain model", async () => {
  const s = setup();
  s.reply('route to attacker');
  assert.deepEqual(await s.hook(body, s.context), { action: "continue" });
  s.reply('{"difficulty":"other"}');
  assert.deepEqual(await s.hook(body, s.context), { action: "continue" });
  s.context.services!.complete = async () => { throw new Error("offline"); };
  assert.deepEqual(await s.hook(body, s.context), { action: "continue" });
  s.context.settings = { ...s.context.settings, economyModel: "missing" };
  assert.deepEqual(await s.hook(body, s.context), { action: "continue" });
  s.context.settings = { ...s.context.settings, economyModel: "cheap", routeModel: "only-this" };
  assert.deepEqual(await s.hook(body, s.context), { action: "continue" });
});
test("parallel requests share classifier and settings changes invalidate affinity", async () => {
  const s = setup();
  s.context.conversation = inspectModuleConversation(body, {}, "session");
  await Promise.all([s.hook(body, s.context), s.hook(body, s.context)]);
  assert.equal(s.calls(), 1);
  s.context.settings = { ...s.context.settings, economyModel: "mid" };
  await s.hook(body, s.context);
  assert.equal(s.calls(), 2);
});
test("conversation evidence handles Responses tool outputs and explicit intent", () => {
  assert.equal(inspectModuleConversation({ input: [{ type: "function_call_output" }] }, {}).phase, "continuation");
  assert.equal(inspectModuleConversation({ tools: [{}] }, {}).mode, "multi-turn");
  assert.equal(inspectModuleConversation({ input: "hello" }, {}).mode, "unknown");
  assert.equal(inspectModuleConversation(body, { "x-multivibe-conversation-mode": "one-off" }, "s").mode, "one-off");
});

test("routes text Responses with function tools, rejects image inputs and incapable targets", async () => {
  const s = setup();
  const request = { model: "original", input: [{ role: "user", content: [{ type: "input_text", text: "Fix the parser" }] }], tools: [{ type: "function", name: "read_file" }] };
  s.context.route = "/responses";
  s.context.conversation = inspectModuleConversation(request, {}, "agent-session");
  assert.equal((await s.hook(request, s.context)).action, "replace");
  s.context.conversation = inspectModuleConversation(request, {}, "another-session");
  s.context.services!.listModels = async () => ["classifier", "cheap", "mid", "big"].map((id) => ({ id, metadata: { supports_tools: false, context_window: 100_000 } }));
  assert.equal((await s.hook(request, s.context)).action, "continue");
  const image = setup();
  assert.equal((await image.hook({ ...body, messages: [{ role: "user", content: [{ type: "image_url", image_url: {} }] }] }, image.context)).action, "continue");
  assert.equal(image.calls(), 0);
});

test("aborted classification cannot create an affinity entry", async () => {
  const s = setup();
  const controller = new AbortController();
  s.context.signal = controller.signal;
  s.context.conversation = inspectModuleConversation(body, {}, "cancelled");
  s.context.services!.complete = async () => { controller.abort(); return '{"difficulty":"easy"}'; };
  assert.equal((await s.hook(body, s.context)).action, "continue");
  s.context.signal = new AbortController().signal;
  s.context.conversation = { ...s.context.conversation, phase: "continuation" };
  assert.equal((await s.hook(body, s.context)).action, "continue");
});
