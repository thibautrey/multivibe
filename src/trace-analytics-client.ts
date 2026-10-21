import { Worker } from "node:worker_threads";
import type { TraceManagerConfig } from "./traces.js";

export type AnalyticsStatus = {
  ready: boolean;
  indexed: number;
  lastIngestedAt?: number;
  pendingBytes: number;
  invalidLines: number;
  error?: string;
};

/** One bounded RPC queue and one worker per store, never one full scan per viewer. */
export class TraceAnalyticsClient {
  status: AnalyticsStatus = { ready: false, indexed: 0, pendingBytes: 0, invalidLines: 0 };
  private worker?: Worker;
  private opening?: Promise<void>;
  private sequence = 0;
  private stopped = false;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private inFlight = new Map<string, Promise<any>>();
  constructor(private config: TraceManagerConfig) {}

  initialize(): Promise<void> {
    return this.opening ??= new Promise((resolve, reject) => {
      const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
      const url = new URL(`./trace-analytics-worker.${extension}`, import.meta.url);
      const workerData = { filePath: this.config.filePath,
        historyFilePath: this.config.historyFilePath ?? `${this.config.filePath}.stats-history`,
        dbPath: this.config.indexedHistoryPath, externalWriter: this.config.externalWriter,
        retentionMax: this.config.retentionMax ?? 1000 };
      // tsImport is needed only by source-level tests; releases run plain compiled JS.
      this.worker = extension === "ts"
        ? new Worker(new URL("./trace-analytics-bootstrap.mjs", import.meta.url), { workerData: { ...workerData, sourceModule: url.href, sourceParent: import.meta.url }, resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 16 } })
        : new Worker(url, { workerData, resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 16 } });
      const fail = (error: Error) => {
        this.status.error = error.message;
        reject(error);
        for (const item of this.pending.values()) item.reject(error);
        this.pending.clear();
      };
      this.worker.on("error", fail);
      this.worker.on("exit", (code) => { if (!this.stopped) fail(new Error(`Analytics worker exited (${code})`)); });
      this.worker.on("message", (message) => {
        if (message.status) { this.status = message.status; return; }
        if (message.opened) { resolve(); this.worker!.unref(); return; }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.value);
      });
    });
  }

  async call<T = any>(action: string, args: Record<string, unknown>): Promise<T> {
    await this.initialize();
    if (this.stopped) throw new Error("Analytics store is closed");
    if (this.status.error && action !== "close" && action !== "sync") throw new Error(this.status.error);
    const key = JSON.stringify([action, args]);
    const shared = this.inFlight.get(key);
    if (shared) return shared;
    if (this.pending.size >= 64) throw new Error("Analytics query capacity exceeded");
    const id = ++this.sequence;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.ref();
      this.worker!.postMessage({ id, action, args });
    });
    this.inFlight.set(key, promise);
    try { return await promise; }
    finally { this.inFlight.delete(key); if (!this.pending.size) this.worker?.unref(); }
  }

  async close(): Promise<void> {
    if (this.stopped || !this.worker) return;
    await this.call("close", {});
    this.stopped = true;
    await this.worker.terminate();
  }
}
