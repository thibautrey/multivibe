import assert from "node:assert/strict";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import express from "express";
import type { AddressInfo } from "node:net";

process.env.REQUEST_BODY_LIMIT = "1kb";
const { createBodyParserMiddleware } = await import("./decompression.js");

async function server() {
  const app = express();
  app.use(createBodyParserMiddleware());
  app.post("/", (req, res) => res.json({
    body: req.body,
    rawLength: req.rawBody?.length,
    contentEncoding: req.headers["content-encoding"] ?? null,
  }));
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/`;
  return { url, close: async () => { listener.closeAllConnections(); await new Promise<void>((resolve) => listener.close(() => resolve())); } };
}

test("decompresses a zstd request body through the pinned core decoder", async () => {
  const { url, close } = await server();
  try {
    const payload = Buffer.from(JSON.stringify({ hello: "world" }));
    const compressed = zstdCompressSync(payload);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "zstd" },
      body: compressed,
    });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.deepEqual(body.body, { hello: "world" });
    assert.equal(body.rawLength, compressed.length);
    assert.equal(body.contentEncoding, null);
  } finally {
    await close();
  }
});

test("rejects a decompressed body beyond the configured limit", async () => {
  const { url, close } = await server();
  try {
    const payload = Buffer.from(JSON.stringify({ filler: "x".repeat(4_096) }));
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "zstd" },
      body: zstdCompressSync(payload),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json() as any).error.message, /decompress zstd body/);
  } finally {
    await close();
  }
});

test("rejects a compressed body beyond the transport limit before decoding", async () => {
  const { url, close } = await server();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "zstd" },
      body: Buffer.alloc(2_048, 7),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json() as any).error.code, "payload_too_large");
  } finally {
    await close();
  }
});

test("rejects invalid zstd data", async () => {
  const { url, close } = await server();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "zstd" },
      body: Buffer.from("not zstd at all"),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json() as any).error.message, /decompress zstd body/);
  } finally {
    await close();
  }
});
