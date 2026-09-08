import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { getQuickJS, type QuickJSContext, type QuickJSRuntime, type QuickJSDeferredPromise, type QuickJSHandle } from "quickjs-emscripten";
import type { ModuleContext, ModuleHookName, ModuleHookResult, ModuleManifest, MultivibeModule } from "./module-sdk.js";

const MAX_BRIDGE_BYTES = 4 * 1024 * 1024;
const CRYPTO_MODULE = `
export function randomBytes(size) { return Uint8Array.from(JSON.parse(__crypto("random", JSON.stringify(size)))); }
export function createHash(algorithm) {
  const chunks = [];
  return { update(value) { chunks.push(typeof value === "string" ? value : Array.from(value)); return this; },
    digest(encoding) { if (encoding !== "hex") throw new Error("Only hex digests are supported");
      return JSON.parse(__crypto("hash", JSON.stringify({algorithm,chunks}))); } };
}`;

/** Each disk plugin runs in its own WASM JavaScript heap, with no Node globals. */
export class ModuleSandbox {
  private runtime!: QuickJSRuntime;
  private vm!: QuickJSContext;
  private disposed = false;
  private deadline = 0;
  private active?: ModuleContext;
  private calls = 0;
  private deferred = new Set<QuickJSDeferredPromise>();
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;

  static async load(root: string, manifest: ModuleManifest): Promise<ModuleSandbox> {
    const sandbox = new ModuleSandbox();
    try { await sandbox.initialize(root, manifest); return sandbox; }
    catch (error) { sandbox.close(); throw error; }
  }
  private async initialize(root: string, manifest: ModuleManifest) {
    const QuickJS = await getQuickJS();
    this.runtime = QuickJS.newRuntime();
    this.runtime.setMemoryLimit(32 * 1024 * 1024);
    this.runtime.setMaxStackSize(512 * 1024);
    this.deadline = Date.now() + 2000;
    this.runtime.setInterruptHandler(() => this.disposed || Date.now() > this.deadline || Boolean(this.active?.signal.aborted));
    const canonicalRoot = fs.realpathSync(root);
    let loadedBytes = 0;
    this.runtime.setModuleLoader((name) => {
      if (name === "node:crypto") return CRYPTO_MODULE;
      const resolved = fs.realpathSync(name);
      if (!resolved.startsWith(canonicalRoot + path.sep) || !/\.[cm]?js$/.test(resolved)) throw new Error("Sandbox imports must be JavaScript files inside this plugin");
      const stat = fs.statSync(resolved);
      loadedBytes += stat.size;
      if (!stat.isFile() || stat.size > 1024 * 1024 || loadedBytes > 8 * 1024 * 1024) throw new Error("Sandbox module source quota exceeded");
      return fs.readFileSync(resolved, "utf8");
    }, (base, name) => {
      if (name === "node:crypto") return name;
      if (!name.startsWith("./") && !name.startsWith("../")) throw new Error(`Unsupported sandbox import: ${name}`);
      const resolved = path.resolve(path.dirname(base), name);
      if (!resolved.startsWith(canonicalRoot + path.sep)) throw new Error("Sandbox import escapes plugin");
      return resolved;
    });
    this.vm = this.runtime.newContext();
    const crypto = this.vm.newFunction("__crypto", (operation, argument) => {
      const op = this.vm.getString(operation);
      const raw = this.vm.getString(argument);
      if (raw.length > MAX_BRIDGE_BYTES) throw new Error("Crypto input too large");
      const data = JSON.parse(raw);
      if (op === "random") {
        if (!Number.isInteger(data) || data < 1 || data > 4096) throw new Error("Invalid random byte count");
        return this.vm.newString(JSON.stringify([...randomBytes(data)]));
      }
      if (op !== "hash" || data?.algorithm !== "sha256" || !Array.isArray(data.chunks)) throw new Error("Only SHA-256 is supported");
      const hash = createHash("sha256");
      for (const chunk of data.chunks) hash.update(typeof chunk === "string" ? chunk : Buffer.from(chunk));
      return this.vm.newString(JSON.stringify(hash.digest("hex")));
    });
    this.vm.setProp(this.vm.global, "__crypto", crypto); crypto.dispose();
    const bridge = this.vm.newFunction("__bridge", (method, args) => {
      const context = this.active;
      if (!context || context.signal.aborted || ++this.calls > 1000) throw new Error("Plugin capability is inactive or quota exceeded");
      const name = this.vm.getString(method);
      const raw = this.vm.getString(args);
      if (raw.length > MAX_BRIDGE_BYTES) throw new Error("Plugin operation too large");
      const values = JSON.parse(raw);
      if (!Array.isArray(values)) throw new Error("Invalid plugin arguments");
      const deferred = this.vm.newPromise();
      this.deferred.add(deferred);
      Promise.resolve().then(() => {
        if (this.disposed || this.active !== context || context.signal.aborted) throw new Error("Plugin operation cancelled");
        // Explicit dispatch: never resolve a plugin-provided property on a host object.
        switch (name) {
          case "storage.get": return context.storage!.get(values[0]);
          case "storage.set": return context.storage!.set(values[0], values[1], values[2]);
          case "storage.delete": return context.storage!.delete(values[0]);
          case "storage.list": return context.storage!.list(values[0], values[1]);
          case "storage.recordEvent": return context.storage!.recordEvent(values[0]);
          case "storage.readEvents": return context.storage!.readEvents(values[0], values[1]);
          case "services.listModels": return context.services!.listModels();
          case "services.complete": return context.services!.complete(values[0], context.signal);
          case "services.completeWithUsage": return context.services!.completeWithUsage!(values[0], context.signal);
          case "log.info": return context.log.info(String(values[0]).slice(0, 2000));
          case "log.warn": return context.log.warn(String(values[0]).slice(0, 2000));
          case "log.error": return context.log.error(String(values[0]).slice(0, 2000));
          default: throw new Error("Unknown plugin capability");
        }
      }).then((value) => this.settle(deferred, context, value, false), (error) => this.settle(deferred, context, error instanceof Error ? error.message : "Plugin operation failed", true));
      return deferred.handle;
    });
    this.vm.setProp(this.vm.global, "__bridge", bridge); bridge.dispose();
    const bootstrap = this.vm.evalCode(`
      const rpc = async (name, args) => JSON.parse(await __bridge(name, JSON.stringify(args)));
      globalThis.__invoke = async (hook, value, metadata) => {
        const context = {...metadata, settings: Object.freeze(metadata.settings),
          signal: Object.freeze({aborted: false, throwIfAborted() {}}),
          storage: Object.freeze(Object.fromEntries(["get","set","delete","list","recordEvent","readEvents"].map(name => [name, (...args) => rpc("storage."+name,args)]))),
          log: Object.freeze(Object.fromEntries(["info","warn","error"].map(name => [name, (...args) => rpc("log."+name,args)]))),
        };
        if (metadata.hasServices) context.services = Object.freeze({
          listModels: () => rpc("services.listModels", []),
          complete: (input) => rpc("services.complete", [input]),
          ...(metadata.hasUsage ? {completeWithUsage: (input) => rpc("services.completeWithUsage", [input])} : {})
        });
        return (await __implementation[hook]?.(value, context)) ?? {action:"continue"};
      };
    `);
    this.vm.unwrapResult(bootstrap).dispose();
    const entrypoint = path.relative(canonicalRoot, path.resolve(canonicalRoot, manifest.entrypoint)).split(path.sep).join("/");
    const result = this.vm.evalCode(`import * as implementation from ${JSON.stringify("./" + entrypoint)}; globalThis.__implementation = implementation.default ?? implementation.module;`, path.join(canonicalRoot, "__multivibe_bootstrap.js"), { type: "module" });
    const exported = this.vm.unwrapResult(result);
    try {
      const state = this.vm.getPromiseState(exported);
      if (state.type === "pending") throw new Error("Sandbox modules must not use top-level await");
      if (state.type === "rejected") { const error = this.vm.dump(state.error); state.error.dispose(); throw new Error(String(error?.message ?? error)); }
      if (state.value !== exported) state.value.dispose();
    } finally { exported.dispose(); }
    this.vm.unwrapResult(this.vm.evalCode(`if (!globalThis.__implementation || typeof globalThis.__implementation !== "object") throw new Error("Plugin must export a module object")`)).dispose();
    this.deadline = Infinity;
  }
  private settle(deferred: QuickJSDeferredPromise, context: ModuleContext, value: unknown, error: boolean) {
    if (this.disposed || !this.deferred.has(deferred)) return;
    if (this.active !== context || context.signal.aborted) { value = "Plugin operation cancelled"; error = true; }
    let encoded = JSON.stringify(value ?? null);
    if (encoded.length > MAX_BRIDGE_BYTES) { encoded = JSON.stringify("Plugin result too large"); error = true; }
    const handle = this.vm.newString(error ? String(value) : encoded);
    if (error) deferred.reject(handle); else deferred.resolve(handle);
    handle.dispose();
    deferred.dispose(); this.deferred.delete(deferred);
  }
  implementation(manifest: ModuleManifest): MultivibeModule {
    return Object.fromEntries(manifest.hooks.map((hook) => [hook, (value: unknown, context: ModuleContext) => this.invoke(hook, value, context, manifest.timeoutMs ?? 5000)]));
  }
  private invoke(hook: ModuleHookName, value: unknown, context: ModuleContext, timeoutMs: number): Promise<ModuleHookResult> {
    if (++this.queued > 100) { this.queued--; return Promise.reject(new Error("Plugin sandbox queue is full")); }
    const run = this.tail.catch(() => undefined).then(async () => {
      if (this.disposed || context.signal.aborted) throw new Error("Plugin sandbox is closed or cancelled");
      this.active = context; this.calls = 0;
      this.deadline = Date.now() + Math.max(10, Math.min(60_000, timeoutMs));
      let result: QuickJSHandle | undefined;
      try {
        const { signal: _signal, services: _services, storage: _storage, log: _log, ...metadata } = context;
        const args = JSON.stringify([hook, value, { ...metadata, hasServices: Boolean(context.services), hasUsage: Boolean(context.services?.completeWithUsage) }]);
        if (args.length > 16 * 1024 * 1024) throw new Error("Plugin hook payload exceeds sandbox quota");
        result = this.vm.unwrapResult(this.vm.evalCode(`__invoke(...${args})`));
        while (!context.signal.aborted && Date.now() <= this.deadline) {
          this.runtime.executePendingJobs(100).unwrap();
          const state = this.vm.getPromiseState(result);
          if (state.type === "fulfilled") { try { return this.vm.dump(state.value); } finally { state.value.dispose(); } }
          if (state.type === "rejected") { const error = this.vm.dump(state.error); state.error.dispose(); throw new Error(String(error?.message ?? error)); }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error("Plugin sandbox hook timed out or was cancelled");
      } finally {
        result?.dispose(); this.active = undefined;
        for (const deferred of this.deferred) deferred.dispose();
        this.deferred.clear(); this.deadline = Infinity;
      }
    });
    this.tail = run.finally(() => { this.queued--; });
    // The caller owns the returned rejection; keep the queue tail handled too.
    void this.tail.catch(() => undefined);
    return run;
  }
  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Finish an active hook before releasing handles owned by its finally block.
    const dispose = () => { for (const deferred of this.deferred) deferred.dispose(); this.deferred.clear(); this.vm?.dispose(); this.runtime?.dispose(); };
    if (this.active) void this.tail.catch(() => undefined).then(dispose); else dispose();
  }
}
