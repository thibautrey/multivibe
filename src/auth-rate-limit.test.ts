import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createAuthRateLimiter } from "./auth-rate-limit.js";

// Exercise the HTTP contract and prove rejected requests never reach auth work.
test("authentication budget returns Retry-After and reopens after the window", async (t) => {
  let now = 1_000;
  let calls = 0;
  const app = express();
  app.post("/login", createAuthRateLimiter({ limit: 2, windowMs: 2_000, now: () => now }), (_req, res) => {
    calls++;
    res.sendStatus(204);
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const request = () => fetch(`http://127.0.0.1:${address.port}/login`, { method: "POST" });
  assert.equal((await request()).status, 204);
  assert.equal((await request()).status, 204);
  now += 500;
  const rejected = await request();
  assert.equal(rejected.status, 429);
  assert.equal(rejected.headers.get("retry-after"), "2");
  assert.equal(rejected.headers.get("cache-control"), "no-store");
  assert.equal(calls, 2);
  now = 3_000;
  assert.equal((await request()).status, 204);
  assert.equal(calls, 3);
});
