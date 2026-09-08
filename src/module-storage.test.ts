import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModuleStorageManager } from "./module-storage.js";

test("private SQLite namespaces persist, deduplicate events, expire values and enforce quotas", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-data-"));
  let manager = new ModuleStorageManager(root);
  try {
    const a = manager.forPlugin("test.plugin-a"); const b = manager.forPlugin("test.plugin-b");
    await a.set("same", { secret: "a" }); await b.set("same", { secret: "b" });
    assert.deepEqual(await a.get("same"), { secret: "a" });
    assert.deepEqual(await b.get("same"), { secret: "b" });
    await a.recordEvent({ id: "one", type: "routing", metrics: { savings: -0.5 } });
    await a.recordEvent({ id: "one", type: "routing", metrics: { savings: 999 } });
    assert.equal(manager.summary("test.plugin-a").types.routing.metrics.savings, -0.5);
    assert.deepEqual(await b.readEvents(), []);
    await assert.rejects(a.set("large", "x".repeat(65536)), /64 KiB/);
    await assert.rejects(a.recordEvent({ id: "bad", type: "routing", metrics: { invalid: NaN } }), /finite/);
    await assert.rejects(a.list("", 1001), /Limit/);
    await assert.rejects(manager.forPlugin("../../outside").get("key"), /Invalid plugin id/);
    await a.set("ttl", true, 1);
    const originalNow = Date.now;
    try { Date.now = () => originalNow() + 2000; assert.equal(await a.get("ttl"), null); }
    finally { Date.now = originalNow; }
    manager.close(); manager = new ModuleStorageManager(root);
    assert.deepEqual(await manager.forPlugin("test.plugin-a").get("same"), { secret: "a" });
    assert.equal(manager.summary("test.plugin-a").types.routing.count, 1);
    for (const directory of await fs.readdir(root)) {
      assert.equal((await fs.stat(path.join(root, directory, "state.sqlite"))).mode & 0o777, 0o600);
    }
  } finally { manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});
