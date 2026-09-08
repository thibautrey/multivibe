import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { ModuleStorage, ModuleStorageEvent } from "./module-sdk.js";

const MAX_JSON_BYTES = 64 * 1024;
const MAX_EVENTS = 10_000;
function json(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined || Buffer.byteLength(text) > MAX_JSON_BYTES) throw new Error("Plugin data must be JSON, at most 64 KiB");
  return text;
}
function key(value: string): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 256) throw new Error("Invalid plugin data key");
  return value;
}
function directory(root: string): void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error("Plugin data directory cannot be a symlink");
  fs.chmodSync(root, 0o700);
}

/** A host-owned SQLite connection. Plugins receive only bound JSON operations. */
export class ModuleStorageManager {
  private owners = new Map<string, string>();
  private databases = new Map<string, Database.Database>();
  constructor(private root: string) {}
  registerOwner(id: string, origin: string): void {
    this.owners.set(id, origin);
  }
  private database(id: string, owner = this.owners.get(id) ?? "local"): Database.Database {
    if (!/^[a-z0-9][a-z0-9.-]{2,127}$/.test(id)) throw new Error("Invalid plugin id");
    const identity = JSON.stringify([id, owner]);
    const existing = this.databases.get(identity);
    if (existing) return existing;
    directory(this.root);
    const root = path.join(this.root, createHash("sha256").update(identity).digest("hex"));
    directory(root);
    const filename = path.join(root, "state.sqlite");
    const fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
    fs.closeSync(fd);
    fs.chmodSync(filename, 0o600);
    const db = new Database(filename, { timeout: 100 });
    db.pragma("journal_mode = DELETE");
    db.pragma("max_page_count = 16384"); // 64 MiB at the default 4 KiB page size.
    db.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, metrics TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_type_at ON events(type, at);`);
    this.databases.set(identity, db);
    return db;
  }
  forPlugin(id: string): ModuleStorage {
    const owner = this.owners.get(id) ?? "local";
    const db = () => this.database(id, owner);
    const prune = () => db().prepare("DELETE FROM kv WHERE expires <= ?").run(Date.now());
    return Object.freeze({
      get: async (name: string) => {
        const row = db().prepare("SELECT value FROM kv WHERE key = ? AND (expires IS NULL OR expires > ?)").get(key(name), Date.now()) as { value: string } | undefined;
        return row ? JSON.parse(row.value) : null;
      },
      set: async (name: string, value: unknown, ttlSeconds?: number) => {
        key(name); const serialized = json(value);
        if (ttlSeconds !== undefined && (!Number.isFinite(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 31_536_000)) throw new Error("Invalid plugin data TTL");
        prune();
        const count = db().prepare("SELECT COUNT(*) AS n FROM kv").get() as { n: number };
        if (count.n >= 10_000 && !db().prepare("SELECT 1 FROM kv WHERE key = ?").get(name)) throw new Error("Plugin key quota exceeded");
        db().prepare("INSERT INTO kv(key,value,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires=excluded.expires")
          .run(name, serialized, ttlSeconds === undefined ? null : Date.now() + ttlSeconds * 1000);
      },
      delete: async (name: string) => { db().prepare("DELETE FROM kv WHERE key = ?").run(key(name)); },
      list: async (prefix = "", limit = 100) => {
        if (typeof prefix !== "string" || prefix.length > 256) throw new Error("Invalid prefix");
        prune();
        return (db().prepare("SELECT key FROM kv WHERE substr(key,1,?) = ? ORDER BY key LIMIT ?").all(prefix.length, prefix, boundedLimit(limit)) as { key: string }[]).map((row) => row.key);
      },
      recordEvent: async (event: ModuleStorageEvent) => {
        key(event.id); key(event.type);
        const metrics = event.metrics ?? {};
        if (!metrics || Array.isArray(metrics) || typeof metrics !== "object" || Object.values(metrics).some((n) => typeof n !== "number" || !Number.isFinite(n))) throw new Error("Event metrics must be finite numbers");
        const data = json(event.data ?? {}); const encodedMetrics = json(metrics);
        db().transaction(() => {
          db().prepare("INSERT OR IGNORE INTO events(id,type,at,data,metrics) VALUES(?,?,?,?,?)").run(event.id, event.type, Date.now(), data, encodedMetrics);
          db().prepare("DELETE FROM events WHERE seq <= (SELECT MAX(seq) - ? FROM events)").run(MAX_EVENTS);
        })();
      },
      readEvents: async (type?: string, limit = 100) => {
        if (type !== undefined) key(type);
        const rows = (type === undefined
          ? db().prepare("SELECT id,type,at,data,metrics FROM events ORDER BY seq DESC LIMIT ?").all(boundedLimit(limit))
          : db().prepare("SELECT id,type,at,data,metrics FROM events WHERE type = ? ORDER BY seq DESC LIMIT ?").all(type, boundedLimit(limit))) as any[];
        return rows.map((row) => ({ ...row, data: JSON.parse(row.data), metrics: JSON.parse(row.metrics) }));
      },
    });
  }
  summary(id: string) {
    const db = this.database(id);
    const types: Record<string, { count: number; metrics: Record<string, number> }> = Object.create(null);
    for (const row of db.prepare("SELECT type,metrics FROM events").iterate() as Iterable<{ type: string; metrics: string }>) {
      const entry = types[row.type] ??= { count: 0, metrics: Object.create(null) };
      entry.count++;
      for (const [name, value] of Object.entries(JSON.parse(row.metrics))) entry.metrics[name] = (entry.metrics[name] ?? 0) + Number(value);
    }
    return { retention: MAX_EVENTS, types };
  }
  close(): void { for (const db of this.databases.values()) db.close(); this.databases.clear(); }
}
function boundedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Limit must be an integer from 1 to 1000");
  return limit;
}
