import assert from "node:assert/strict";
import test from "node:test";
import { createManusModel, fetchManusUsage, parseManusUsage } from "./manus-provider.js";
import { sdkCallOptions, chatResult } from "./protocol.js";

const options = () => sdkCallOptions({ messages: [{ role: "user", content: "Research trees" }] }, new AbortController().signal);
const stopped = { ok: true, messages: [
  { type: "status_update", status_update: { agent_status: "stopped" } },
  { type: "assistant_message", assistant_message: { content: "Tree report" } },
] };

test("Manus creates one private task and polls its documented event endpoint", async () => {
  const paths: string[] = [];
  const model = createManusModel("secret", "standard", async (input, init) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    assert.equal(url.origin, "https://api.manus.ai");
    assert.equal(new Headers(init?.headers).get("x-manus-api-key"), "secret");
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    if (url.pathname.endsWith("task.create")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.share_visibility, "private");
      assert.equal(body.agent_profile, "standard");
      assert.equal(body.interactive_mode, true);
      assert.deepEqual(body.message.connectors, []);
      assert.match(body.message.content, /user:\nResearch trees/);
      return Response.json({ ok: true, task_id: "task123" });
    }
    assert.equal(url.searchParams.get("task_id"), "task123");
    return Response.json(stopped);
  }, 0);
  const result = await model.doGenerate(options());
  assert.equal(result.content[0].type, "text");
  assert.equal((result.content[0] as any).text, "Tree report");
  assert.equal(result.usage.inputTokens.total, undefined);
  assert.deepEqual(paths, ["/v2/task.create", "/v2/task.listMessages"]);
});

test("Manus returns waiting tasks to the user without approving actions", async () => {
  const paths: string[] = [];
  const model = createManusModel("secret", "lite", async (input) => {
    const url = new URL(String(input)); paths.push(url.pathname);
    return Response.json(url.pathname.endsWith("task.create") ? { ok: true, task_id: "waiting123" } : {
      ok: true, messages: [{ type: "status_update", status_update: { agent_status: "waiting" } },
        { type: "assistant_message", assistant_message: { content: "Approve this action?" } }],
    });
  }, 0);
  const result = chatResult("manus/lite", await model.doGenerate(options()));
  assert.match(result.choices[0].message.content!, /https:\/\/manus.im\/app\/waiting123/);
  assert.ok(!paths.some((path) => /confirm|sendMessage/.test(path)));
});

test("Manus stops its task after cancellation using a fresh bounded signal", async () => {
  const controller = new AbortController();
  let stoppedTask = false;
  const model = createManusModel("secret", "max", async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("task.create")) return Response.json({ ok: true, task_id: "cancel123" });
    if (path.endsWith("task.stop")) {
      stoppedTask = true;
      assert.equal(init?.signal?.aborted, false);
      assert.deepEqual(JSON.parse(String(init?.body)), { task_id: "cancel123" });
      return Response.json({ ok: true });
    }
    controller.abort();
    return Response.json({ ok: true, messages: [{ type: "status_update", status_update: { agent_status: "running" } }] });
  }, 0);
  await assert.rejects(async () => await model.doGenerate({ ...options(), abortSignal: controller.signal }));
  assert.equal(stoppedTask, true);
});

test("Manus rejects unsupported LLM options before spending credits", async () => {
  let requests = 0;
  const model = createManusModel("secret", "standard", async () => { requests++; throw new Error("Unexpected request"); });
  await assert.rejects(async () => await model.doGenerate({ ...options(), maxOutputTokens: 20 }), /Manus supports text tasks/);
  await assert.rejects(async () => await model.doGenerate({ ...options(), prompt: [{ role: "user", content: [{ type: "file", mediaType: "image/png", data: { type: "data", data: "AA==" } }] }] }), /text-only/);
  assert.equal(requests, 0);
});

test("Manus handles paginated events and emits buffered output as SSE parts", async () => {
  const model = createManusModel("secret", "standard", async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("task.create")) return Response.json({ ok: true, task_id: "pages123" });
    if (!url.searchParams.has("cursor")) return Response.json({ ok: true,
      messages: [{ type: "status_update", status_update: { agent_status: "stopped" } }], has_more: true, next_cursor: "next" });
    return Response.json({ ok: true, messages: [{ type: "assistant_message", assistant_message: { content: "Paged report" } }], has_more: false });
  }, 0);
  const { stream } = await model.doStream(options());
  const parts = []; for await (const part of stream) parts.push(part);
  assert.ok(parts.some((part) => part.type === "text-delta" && part.delta === "Paged report"));
  assert.ok(parts.some((part) => part.type === "finish"));
});

test("Manus tracks authoritative credits and separates allowances from hard routing limits", async () => {
  const payload = { ok: true, data: { total_credits: 250, periodic_credits: 0, pro_monthly_credits: 1000, addon_credits: 250, current_period_end: 1_800_000_000 } };
  const usage = await fetchManusUsage("secret", undefined, async (input, init) => {
    assert.equal(input, "https://api.manus.ai/v2/usage.availableCredits");
    assert.equal(new Headers(init?.headers).get("x-manus-api-key"), "secret");
    return Response.json(payload);
  });
  assert.equal(usage.balance?.remaining, 250);
  assert.equal(usage.allowances?.[0].usedPercent, 100);
  assert.equal(usage.allowances?.[0].resetAt, 1_800_000_000_000);
  assert.equal(usage.credits, undefined, "add-on credits can still fund inference after subscription credits are spent");
  assert.throws(() => parseManusUsage({ ok: false, data: payload.data }));
  assert.throws(() => parseManusUsage({ ok: true, data: { total_credits: "unknown" } }));
});
