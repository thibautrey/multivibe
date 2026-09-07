import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { HostUpdateController } from "./update-controller.js";

test("Host update drain waits for HTTP, websocket, job and provider operations", async () => {
  let providerOperation = "install";
  const controller = new HostUpdateController("/tmp/multivibe-host-updater", {
    enabled: true,
    getManagedOllamaStatus: async () => ({ operation: providerOperation }),
  } as any);
  let activeJobs = 1;
  let stopped = false;
  controller.attachJobRunner({
    start() { stopped = false; },
    stop() { stopped = true; },
    activeCount() { return activeJobs; },
  });
  controller.websocketTurnStarted();
  await controller.beginDrain();
  assert.equal(stopped, true);
  assert.equal((await controller.readiness()).ready, false);
  controller.websocketTurnFinished();
  activeJobs = 0;
  providerOperation = "";
  assert.deepEqual(await controller.readiness(), {
    draining: true,
    ready: true,
    active_requests: 0,
    active_websocket_turns: 0,
    active_jobs: 0,
    provider_operation: null,
  });
  await controller.resume();
  assert.equal(stopped, false);
});

test("Host update drain rejects new inference requests and counts admitted work", async () => {
  const controller = new HostUpdateController(undefined, undefined);
  const response = new EventEmitter() as any;
  response.setHeader = () => undefined;
  response.status = (status: number) => { response.statusCode = status; return response; };
  response.json = (body: unknown) => { response.body = body; return response; };
  let admitted = false;
  controller.inferenceMiddleware({} as any, response, () => { admitted = true; });
  assert.equal(admitted, true);
  assert.equal((await controller.readiness()).active_requests, 1);
  response.emit("finish");
  assert.equal((await controller.readiness()).active_requests, 0);

  await controller.beginDrain();
  const rejected = new EventEmitter() as any;
  rejected.setHeader = () => undefined;
  rejected.status = (status: number) => { rejected.statusCode = status; return rejected; };
  rejected.json = (body: unknown) => { rejected.body = body; return rejected; };
  controller.inferenceMiddleware({} as any, rejected, () => assert.fail("draining request was admitted"));
  assert.equal(rejected.statusCode, 503);
  assert.equal(controller.admitWebsocket(), false);
});

test("Host update drain coordinates begin, status and resume with the native edge", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls: Array<{
    url: string;
    method: string;
    internalToken: string | null;
  }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      method: String(init?.method),
      internalToken:
        new Headers(init?.headers).get("x-multivibe-internal-token"),
    });
    const action = new URL(url).pathname.split("/").at(-1);
    const status = action === "resume"
      ? {
          draining: false,
          ready: false,
          active_requests: 0,
          active_websocket_turns: 0,
          active_jobs: 0,
        }
      : {
          draining: true,
          ready: action === "begin",
          active_requests: action === "status" ? 2 : 0,
          active_websocket_turns: action === "status" ? 1 : 0,
          active_jobs: action === "status" ? 3 : 0,
        };
    return new Response(JSON.stringify(status), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  let providerOperation = "install";
  let stopped = false;
  const controller = new HostUpdateController(
    "/tmp/multivibe-host-updater",
    {
      enabled: true,
      getManagedOllamaStatus: async () => ({ operation: providerOperation }),
    } as any,
    {
      baseUrl: "http://127.0.0.1:1455///",
      internalToken: "native-edge-token",
    },
  );
  controller.attachJobRunner({
    start() {
      stopped = false;
    },
    stop() {
      stopped = true;
    },
    activeCount() {
      return 99;
    },
  });

  await controller.beginDrain();
  assert.equal(stopped, true);
  assert.deepEqual(await controller.readiness(), {
    draining: true,
    ready: false,
    active_requests: 2,
    active_websocket_turns: 1,
    active_jobs: 3,
    provider_operation: "install",
  });
  providerOperation = "";
  await controller.resume();
  assert.equal(stopped, false);

  assert.deepEqual(calls, [
    {
      url: "http://127.0.0.1:1455/internal/v1-edge/drain/begin",
      method: "POST",
      internalToken: "native-edge-token",
    },
    {
      url: "http://127.0.0.1:1455/internal/v1-edge/drain/status",
      method: "GET",
      internalToken: "native-edge-token",
    },
    {
      url: "http://127.0.0.1:1455/internal/v1-edge/drain/resume",
      method: "POST",
      internalToken: "native-edge-token",
    },
  ]);
});

test("Host update drain rolls back local state when native begin fails", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });

  const jobEvents: string[] = [];
  const controller = new HostUpdateController(
    "/tmp/multivibe-host-updater",
    undefined,
    {
      baseUrl: "http://127.0.0.1:1455",
      internalToken: "native-edge-token",
    },
  );
  controller.attachJobRunner({
    start() {
      jobEvents.push("start");
    },
    stop() {
      jobEvents.push("stop");
    },
    activeCount() {
      return 0;
    },
  });

  await assert.rejects(
    () => controller.beginDrain(),
    /native inference drain returned 503/,
  );
  assert.deepEqual(jobEvents, ["stop", "start"]);
  assert.equal(controller.admitWebsocket(), true);
});

test("Host update readiness rejects an invalid native status", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ draining: true, ready: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const controller = new HostUpdateController(
    undefined,
    undefined,
    {
      baseUrl: "http://127.0.0.1:1455",
      internalToken: "native-edge-token",
    },
  );

  await assert.rejects(
    () => controller.readiness(),
    /native inference drain returned invalid status/,
  );
});

test("Host update resume keeps local admission drained when the native edge fails", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input) => {
    const action = new URL(String(input)).pathname.split("/").at(-1);
    return action === "begin"
      ? new Response(
          JSON.stringify({
            draining: true,
            ready: true,
            active_requests: 0,
            active_websocket_turns: 0,
            active_jobs: 0,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      : new Response("unavailable", { status: 503 });
  };

  const jobEvents: string[] = [];
  const controller = new HostUpdateController(
    undefined,
    undefined,
    {
      baseUrl: "http://127.0.0.1:1455",
      internalToken: "native-edge-token",
    },
  );
  controller.attachJobRunner({
    start() {
      jobEvents.push("start");
    },
    stop() {
      jobEvents.push("stop");
    },
    activeCount() {
      return 0;
    },
  });

  await controller.beginDrain();
  await assert.rejects(
    () => controller.resume(),
    /native inference drain returned 503/,
  );
  assert.deepEqual(jobEvents, ["stop"]);
  assert.equal(controller.admitWebsocket(), false);
});
