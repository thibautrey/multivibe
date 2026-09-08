import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModuleSandbox } from "./module-sandbox.js";
import { ModuleStorageManager } from "./module-storage.js";
import type { ModuleManifest, ModuleContext } from "./module-sdk.js";
const manifest: ModuleManifest = { id: "test.sandbox", name: "Sandbox", version: "1", apiVersion: 1, description: "test", entrypoint: "index.js", repository: "https://github.com/example/test", hooks: ["request.received"], timeoutMs: 5000 };
function context(storage: ModuleContext["storage"]): ModuleContext {
  return { requestId: "test", route: "/responses", transport: "http", signal: new AbortController().signal, settings: {}, storage,
    log: { info() {}, warn() {}, error() {} } };
}

test("sandbox provides private storage without filesystem, Node globals or host object escapes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-sandbox-"));
  const data = new ModuleStorageManager(path.join(root, "data"));
  let a: ModuleSandbox | undefined; let b: ModuleSandbox | undefined;
  try {
    await fs.writeFile(path.join(root, "index.js"), `export default { async "request.received"(value, context) {
      if (value.write) await context.storage.set("secret", value.write);
      return {action:"replace", value: {secret: await context.storage.get("secret"),
        process: typeof process, require: typeof require, fetch: typeof fetch,
        escape: context.storage.get.constructor("return typeof process")()}};
    } };`);
    a = await ModuleSandbox.load(root, manifest); b = await ModuleSandbox.load(root, manifest);
    const hookA = a.implementation(manifest)["request.received"]!; const hookB = b.implementation(manifest)["request.received"]!;
    const first = await hookA({ write: "private-a" }, context(data.forPlugin("test.plugin-a")));
    assert.deepEqual(first, { action: "replace", value: { secret: "private-a", process: "undefined", require: "undefined", fetch: "undefined", escape: "undefined" } });
    assert.deepEqual(await hookB({}, context(data.forPlugin("test.plugin-b"))), { action: "replace", value: { secret: null, process: "undefined", require: "undefined", fetch: "undefined", escape: "undefined" } });
    assert.equal((await hookA({}, context(data.forPlugin("test.plugin-a"))) as any).value.secret, "private-a");
  } finally { a?.close(); b?.close(); data.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("sandbox blocks Node imports, parent traversal, symlinks and runaway initialization", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-imports-"));
  const plugin = path.join(root, "plugin"); await fs.mkdir(plugin);
  try {
    await fs.writeFile(path.join(root, "private.js"), "export default 'private'");
    await fs.symlink(path.join(root, "private.js"), path.join(plugin, "escape.js"));
    for (const source of ["import fs from 'node:fs'; export default {}", "import x from '../private.js'; export default {}", "import x from './escape.js'; export default {}", "while(true){}; export default {}"] ) {
      await fs.writeFile(path.join(plugin, "index.js"), source);
      await assert.rejects(ModuleSandbox.load(plugin, manifest));
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("sandbox interrupts infinite hooks and preserves the supported crypto shim", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-timeout-"));
  let sandbox: ModuleSandbox | undefined;
  try {
    await fs.writeFile(path.join(root, "index.js"), `import {createHash, randomBytes} from 'node:crypto';
      export default { "request.received"(value) { if (value.loop) while(true){};
        return {action:'replace',value:{hash:createHash('sha256').update('hello').digest('hex'), size:randomBytes(4).length}}; } };`);
    sandbox = await ModuleSandbox.load(root, manifest);
    const hook = sandbox.implementation(manifest)["request.received"]!;
    assert.deepEqual(await hook({}, context(undefined)), {action:"replace",value:{hash:"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",size:4}});
    await assert.rejects(async () => sandbox!.implementation({ ...manifest, timeoutMs: 50 })["request.received"]!({loop:true}, context(undefined)));
  } finally { sandbox?.close(); await fs.rm(root, {recursive:true,force:true}); }
});
