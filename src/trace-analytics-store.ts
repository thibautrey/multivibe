import Database from "better-sqlite3";
import { open, unlink, mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { setImmediate as yieldToQueries } from "node:timers/promises";
import {
  normalizeTrace, toStatsHistoryEntry, isHiddenTraceRoute,
  createEmptyBucket, addTraceToBucket, buildBucketTraceStats,
  createUsageAggregate, addTraceToAggregate, finalizeAggregate,
  type TraceEntry, type TraceBucketAggregate, type UsageAggregate, ttftInputTokenBucket,
} from "./traces.js";
import { emptyUsage, addTrace, finalizeUsage, type MutableUsage } from "./project-usage.js";
import { aggregateSessionUsage, sessionTurnsFor, createTurn, addTraceToTurn } from "./session-usage.js";
import { sessionKeyOf } from "./session-identity.js";
import type { AnalyticsStatus } from "./trace-analytics-client.js";

const HOUR = 3_600_000;
const MIN = -Number.MAX_SAFE_INTEGER;
const MAX = Number.MAX_SAFE_INTEGER;
const BATCH = 1000;
const encode = (value: unknown) => JSON.stringify(value, (_key, item) => item instanceof Map ? { $map: [...item] } : item);
const decode = (value: string) => JSON.parse(value, (_key, item) => item && item.$map ? new Map(item.$map) : item);
type Filter = { sinceMs?: number; untilMs?: number; accountId?: string; route?: string; application?: string; projectId?: string };
type Rollup = { meta: TraceEntry; usage: UsageAggregate; project: MutableUsage; sessionAttempts: number };
function bounds(args: Filter) { return [Number.isFinite(args.sinceMs) ? args.sinceMs! : MIN, Number.isFinite(args.untilMs) ? args.untilMs! : MAX]; }
function visible(t: TraceEntry) { return !isHiddenTraceRoute(t.route) && t.traceKind !== "diagnostic"; }
function attempt(t: TraceEntry) { return !t.traceKind || t.traceKind === "upstream-attempt"; }
function matches(t: TraceEntry, f: Filter) { return (!f.accountId || t.accountId === f.accountId) && (!f.route || t.route === f.route) && (!f.application || t.application === f.application) && (!f.projectId || t.projectId === f.projectId); }
function mergeUsage(target: UsageAggregate, source: UsageAggregate) {
  for (const key of ["requests", "ok", "errors", "stream", "latencyMsTotal", "requestsWithUsage", "promptTokens", "completionTokens", "totalTokens"] as const) target[key] += source[key];
  for (const [key, value] of Object.entries(source.statusCounts)) target.statusCounts[key] = (target.statusCounts[key] ?? 0) + value;
  if (source.firstAt !== undefined) target.firstAt = Math.min(target.firstAt ?? MAX, source.firstAt);
  if (source.lastAt !== undefined) target.lastAt = Math.max(target.lastAt ?? MIN, source.lastAt);
}
function mergeProject(target: MutableUsage, source: MutableUsage) {
  for (const key of ["requests", "ok", "errors", "stream", "requestsWithUsage", "requestsWithCost", "unpricedRequests", "costUsd", "tokensInput", "tokensCachedInput", "tokensOutput", "tokensTotal", "latencyMsTotal"] as const) target[key] += source[key];
  for (const [key, value] of Object.entries(source.statusCounts)) target.statusCounts[key] = (target.statusCounts[key] ?? 0) + value;
  // Percentile samples are explicitly bounded, counters and monetary totals remain exact.
  target.latencies.push(...source.latencies);
  if (target.latencies.length > 1024) target.latencies = target.latencies.slice(-1024);
}

export class TraceAnalyticsStore {
  private db: Database.Database;
  private stopped = false;
  private scanning?: Promise<void>;
  private generation = 0;
  private cache = new Map<string, { generation: number; expires: number; value: any }>();
  status: AnalyticsStatus = { ready: false, indexed: 0, pendingBytes: 0, invalidLines: 0 };
  constructor(private config: { dbPath: string; filePath: string; historyFilePath: string; externalWriter?: boolean; retentionMax: number }, private publish: (status: AnalyticsStatus) => void = () => {}) {
    this.db = new Database(config.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("cache_size = -32768");
    this.db.pragma("temp_store = FILE");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, at INTEGER NOT NULL, completed_at INTEGER NOT NULL, session_key TEXT, application TEXT, project_id TEXT, turn_id TEXT NOT NULL, kind TEXT, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS entries_at ON entries(at);
      CREATE INDEX IF NOT EXISTS entries_completed ON entries(completed_at);
      CREATE INDEX IF NOT EXISTS entries_session_at ON entries(session_key, at, id);
      CREATE INDEX IF NOT EXISTS entries_turn_at ON entries(session_key,turn_id,at,id);
      CREATE INDEX IF NOT EXISTS entries_project_at ON entries(project_id, at);
      CREATE INDEX IF NOT EXISTS entries_application_at ON entries(application, at);
      CREATE TABLE IF NOT EXISTS buckets (at INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_buckets (at INTEGER NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(at, key));
      CREATE TABLE IF NOT EXISTS recent (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors (identity TEXT PRIMARY KEY, offset INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_dirty (key TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS session_dirty_revision ON session_dirty(revision);
      CREATE TABLE IF NOT EXISTS session_scopes (scope TEXT PRIMARY KEY, revision INTEGER, until_ms INTEGER, accessed INTEGER);
      CREATE TABLE IF NOT EXISTS session_reports (scope TEXT, key TEXT, payload TEXT, cost REAL, turns INTEGER, last_at INTEGER, PRIMARY KEY(scope,key));
      CREATE INDEX IF NOT EXISTS session_reports_page ON session_reports(scope,cost DESC,turns DESC,last_at DESC,key);
    `);
    this.status.indexed = Number((this.db.prepare("SELECT value FROM metadata WHERE key='count'").get() as any)?.value ?? 0);
    this.status.ready = !!this.db.prepare("SELECT 1 FROM metadata WHERE key='history_imported'").get();
  }

  static async open(config: ConstructorParameters<typeof TraceAnalyticsStore>[0], publish?: (status: AnalyticsStatus) => void) {
    await mkdir(path.dirname(config.dbPath), { recursive: true });
    const store = new TraceAnalyticsStore(config, publish);
    await chmod(config.dbPath, 0o600);
    return store;
  }

  private saveMeta(key: string, value: string) { this.db.prepare("INSERT OR REPLACE INTO metadata VALUES (?,?)").run(key, value); }
  private emit() { this.publish({ ...this.status }); }

  /** Entries, deduplication, aggregates and input cursor commit in one transaction. */
  append(entries: TraceEntry[], cursor?: { identity: string; offset: number }, journal = false) {
    const buckets = new Map<number, TraceBucketAggregate>();
    const rollups = new Map<string, { at: number; key: string; value: Rollup }>();
    const insert = this.db.prepare("INSERT OR IGNORE INTO entries VALUES (?,?,?,?,?,?,?,?,?)");
    const deleteRecent = this.db.prepare("DELETE FROM recent WHERE id=?");
    const insertRecent = this.db.prepare("INSERT INTO recent(id,payload) VALUES (?,?)");
    const getBucket = this.db.prepare("SELECT payload FROM buckets WHERE at=?");
    const getRollup = this.db.prepare("SELECT payload FROM usage_buckets WHERE at=? AND key=?");
    // An acknowledged Rust segment may be deleted: its cursor and entries must
    // survive power loss together, not merely a process restart.
    if (journal) this.db.pragma("synchronous = FULL");
    let inserted = 0;
    this.db.transaction(() => {
      for (const raw of entries) {
        const normalized = normalizeTrace(raw);
        if (!normalized) continue;
        if (journal) {
          deleteRecent.run(normalized.id);
          insertRecent.run(normalized.id, JSON.stringify(normalized));
        }
        if (normalized.lifecycleState === "started" || !visible(normalized)) continue;
        const t = toStatsHistoryEntry(normalized);
        if (!insert.run(t.id, t.at, t.completedAt ?? t.at, sessionKeyOf(t) ?? null, t.application ?? null, t.projectId ?? null, t.clientRequestId ?? t.id, t.traceKind ?? null, JSON.stringify(t)).changes) continue;
        inserted++;
        const sessionKey = attempt(t) ? sessionKeyOf(t) : undefined;
        if (sessionKey) this.db.prepare("INSERT OR REPLACE INTO session_dirty VALUES (?,?)").run(sessionKey, this.status.indexed + inserted);
        const hour = Math.floor(t.at / HOUR) * HOUR;
        let bucket = buckets.get(hour);
        if (!bucket) { const row = getBucket.get(hour) as any; bucket = row ? decode(row.payload) : createEmptyBucket(hour); buckets.set(hour, bucket!); }
        addTraceToBucket(bucket!, t);
        if (!attempt(t)) continue;
        const key = JSON.stringify([t.accountId, t.route, t.application, t.projectId, t.model]);
        const combined = `${hour}:${key}`;
        let rollup = rollups.get(combined);
        if (!rollup) {
          const row = getRollup.get(hour, key) as any;
          rollup = { at: hour, key, value: row ? JSON.parse(row.payload) : { meta: { accountId: t.accountId, route: t.route, application: t.application, projectId: t.projectId, projectName: t.projectName, projectRemote: t.projectRemote, model: t.model }, usage: createUsageAggregate(), project: emptyUsage(), sessionAttempts: 0 } };
          rollups.set(combined, rollup);
        }
        if (sessionKeyOf(t)) rollup.value.sessionAttempts++;
        addTraceToAggregate(rollup.value.usage, t);
        addTrace(rollup.value.project, t);
      }
      for (const [at, bucket] of buckets) this.db.prepare("INSERT OR REPLACE INTO buckets VALUES (?,?)").run(at, encode(bucket));
      for (const r of rollups.values()) this.db.prepare("INSERT OR REPLACE INTO usage_buckets VALUES (?,?,?)").run(r.at, r.key, JSON.stringify(r.value));
      if (journal) this.db.prepare("DELETE FROM recent WHERE seq < COALESCE((SELECT seq FROM recent ORDER BY seq DESC LIMIT 1 OFFSET ?),0)").run(Math.max(0, this.config.retentionMax - 1));
      if (cursor) this.db.prepare("INSERT OR REPLACE INTO cursors VALUES (?,?)").run(cursor.identity, cursor.offset);
      this.saveMeta("count", String(this.status.indexed + inserted));
    })();
    this.status.indexed += inserted;
    if (inserted || journal) { this.generation++; this.cache.clear(); }
  }

  private async consume(file: string, journal: boolean): Promise<boolean | "missing"> {
    let handle;
    try { handle = await open(file, "r"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw e; }
    try {
      const info = await handle.stat();
      // Unraid shfs reports birthtime=0 and can reuse inode numbers after rotation.
      // Bind the cursor to the immutable journal prefix as well as the inode.
      let signature = String(info.birthtimeMs);
      if (!info.birthtimeMs) {
        const prefix = Buffer.alloc(Math.min(256, info.size));
        await handle.read(prefix, 0, prefix.length, 0);
        signature = createHash("sha256").update(prefix).digest("hex");
      }
      const identity = `${info.dev}:${info.ino}:${signature}`;
      let offset = Number((this.db.prepare("SELECT offset FROM cursors WHERE identity=?").get(identity) as any)?.offset ?? 0);
      if (offset > info.size) offset = 0;
      this.status.pendingBytes = Math.max(0, info.size - offset); this.emit();
      if (offset === info.size) return true;
      const input = handle.createReadStream({ start: offset, end: Math.max(0, info.size - 1), autoClose: false, highWaterMark: 256 * 1024 });
      let pending = Buffer.alloc(0);
      let batch: TraceEntry[] = [];
      let committed = offset;
      let lastEmit = Date.now();
      for await (const chunk of input) {
        if (this.stopped) break;
        pending = Buffer.concat([pending, chunk as Buffer]);
        let newline: number;
        while ((newline = pending.indexOf(10)) >= 0) {
          const line = pending.subarray(0, newline).toString("utf8");
          offset += newline + 1; pending = pending.subarray(newline + 1);
          if (line.trim()) { try { const t = normalizeTrace(JSON.parse(line)); if (t) batch.push(t); else this.status.invalidLines++; } catch { this.status.invalidLines++; } }
          if (batch.length >= BATCH || offset - committed >= 1024 * 1024) {
            this.append(batch, { identity, offset }, journal); batch = []; committed = offset;
            this.status.pendingBytes = Math.max(0, info.size - offset);
            this.status.lastIngestedAt = Date.now();
            if (Date.now() - lastEmit > 1000) { this.emit(); lastEmit = Date.now(); }
            await yieldToQueries();
            if (this.stopped) break;
          }
        }
        // Malformed/unbounded lines must not exhaust the worker. Fail without advancing the durable cursor.
        if (pending.length > 16 * 1024 * 1024) throw new Error("Analytics journal line exceeds 16 MiB");
      }
      if (batch.length || offset !== committed) this.append(batch, { identity, offset }, journal);
      this.status.pendingBytes = Math.max(0, info.size - offset);
      this.status.lastIngestedAt = Date.now(); this.emit();
      return offset === info.size && !this.stopped;
    } finally { await handle.close(); }
  }

  sync(): Promise<void> {
    return this.scanning ??= this.runSync().finally(() => { this.scanning = undefined; });
  }
  private async runSync() {
    try {
      if (!this.status.ready) {
        if (!await this.consume(this.config.historyFilePath, false)) return;
        this.saveMeta("history_imported", "1");
      }
      if (this.config.externalWriter) {
        const previous = `${this.config.filePath}.previous`;
        // Rust never overwrites .previous. Its deletion acknowledges a completely committed inode.
        if (await this.consume(previous, true) === true) await unlink(previous).catch((e) => { if (e.code !== "ENOENT") throw e; });
        await this.consume(this.config.filePath, true);
      }
      this.status.ready = true;
      this.status.error = undefined; this.emit();
    } catch (e) { this.status.error = (e as Error).message; this.emit(); throw e; }
  }

  private *range(args: Filter, extra = "", params: unknown[] = []): Generator<TraceEntry> {
    const [since, until] = bounds(args);
    const clauses = ["at >= ?", "at <= ?"];
    const bindings: any[] = [since, until];
    if (args.application) { clauses.push("application = ?"); bindings.push(args.application); }
    if (args.projectId) { clauses.push("project_id = ?"); bindings.push(args.projectId); }
    const sql = `SELECT payload FROM entries WHERE ${clauses.join(" AND ")} ${extra}`;
    for (const row of this.db.prepare(sql).iterate(...bindings, ...params) as Iterable<{ payload: string }>) {
      const t = JSON.parse(row.payload); if (matches(t, args)) yield t;
    }
  }

  /** Only the two partial edge hours touch raw entries; complete hours use durable rollups. */
  private edgeAndHours(args: Filter) {
    const [since, until] = bounds(args);
    const firstFull = since === MIN ? MIN : Math.ceil(since / HOUR) * HOUR;
    const fullEnd = until === MAX ? MAX : Math.floor((until + 1) / HOUR) * HOUR;
    const self = this;
    function* edge(): Generator<TraceEntry> {
      if (firstFull > fullEnd) { yield* self.range(args); return; }
      if (since !== MIN && since < firstFull) yield* self.range({ ...args, untilMs: Math.min(until, firstFull - 1) });
      if (until !== MAX && until >= fullEnd) yield* self.range({ ...args, sinceMs: Math.max(since, fullEnd) });
    }
    return { firstFull, fullEnd, edge: edge() };
  }

  stats(args: Filter) {
    const { firstFull, fullEnd, edge } = this.edgeAndHours(args);
    const buckets = new Map<number, TraceBucketAggregate>();
    for (const row of this.db.prepare("SELECT at,payload FROM buckets WHERE at>=? AND at<? ORDER BY at").iterate(firstFull, fullEnd) as Iterable<any>) buckets.set(row.at, decode(row.payload));
    for (const t of edge) { const hour = Math.floor(t.at / HOUR) * HOUR; const bucket = buckets.get(hour) ?? createEmptyBucket(hour); addTraceToBucket(bucket, t); buckets.set(hour, bucket); }
    return buildBucketTraceStats(buckets.values(), this.status.indexed, args.sinceMs, args.untilMs);
  }

  usage(args: Filter) {
    const { firstFull, fullEnd, edge } = this.edgeAndHours(args);
    const global = createUsageAggregate();
    const dimensions = [new Map<string, UsageAggregate>(), new Map<string, UsageAggregate>(), new Map<string, UsageAggregate>()];
    const projects = new Map<string, { meta: TraceEntry; usage: MutableUsage; models: Map<string, MutableUsage>; firstAt?: number; lastAt?: number }>();
    const merge = (r: Rollup) => {
      if (!matches(r.meta, args)) return;
      mergeUsage(global, r.usage);
      const keys = [r.meta.accountId ?? "unknown", r.meta.route ?? "unknown", r.meta.application ?? "unattributed"];
      dimensions.forEach((map, i) => { const agg = map.get(keys[i]) ?? createUsageAggregate(); mergeUsage(agg, r.usage); map.set(keys[i], agg); });
      const key = r.meta.projectId ?? "unattributed";
      const p = projects.get(key) ?? { meta: r.meta, usage: emptyUsage(), models: new Map<string, MutableUsage>() };
      mergeProject(p.usage, r.project);
      const model = r.meta.model || "unknown"; const m = p.models.get(model) ?? emptyUsage(); mergeProject(m, r.project); p.models.set(model, m);
      p.firstAt = Math.min(p.firstAt ?? MAX, r.usage.firstAt ?? MAX); p.lastAt = Math.max(p.lastAt ?? MIN, r.usage.lastAt ?? MIN);
      projects.set(key, p);
    };
    for (const row of this.db.prepare("SELECT payload FROM usage_buckets WHERE at>=? AND at<? ORDER BY at,key").iterate(firstFull, fullEnd) as Iterable<any>) merge(JSON.parse(row.payload));
    for (const t of edge) if (attempt(t)) { const usage = createUsageAggregate(); addTraceToAggregate(usage, t); const project = emptyUsage(); addTrace(project, t); merge({ meta: t, usage, project, sessionAttempts: sessionKeyOf(t) ? 1 : 0 }); }
    const by = (i: number, label: string) => [...dimensions[i]].map(([key, agg]) => ({ [label]: key, ...finalizeAggregate(agg) })).sort((a, b) => b.requests - a.requests);
    const byProject = [...projects].map(([projectId, p]) => ({ projectId, projectName: p.meta.projectName, projectRemote: p.meta.projectRemote, firstAt: p.firstAt, lastAt: p.lastAt, ...finalizeUsage(p.usage), models: [...p.models].map(([model, value]) => ({ model, ...finalizeUsage(value) })).sort((a,b) => b.costUsd-a.costUsd || b.requests-a.requests) })).sort((a,b) => b.costUsd-a.costUsd || b.requests-a.requests);
    const [since, until] = bounds(args);
    const tracesEvaluated = (this.db.prepare("SELECT count(*) AS n FROM entries WHERE at>=? AND at<=?").get(since, until) as any).n;
    return { totals: finalizeAggregate(global), byAccount: by(0, "accountId"), byRoute: by(1, "route"), byApplication: by(2, "application"), byProject, tracesEvaluated, tracesMatched: global.requests };
  }

  /** Oversized sessions spill turn state to SQLite instead of growing a JS map without limit. */
  private sessionReport(args: Filter, key: string): any {
    const [since,until]=bounds(args);
    const n=(this.db.prepare("SELECT count(*) AS n FROM entries WHERE session_key=? AND at>=? AND at<=?").get(key,since,until) as any).n;
    if(n<=10000) return aggregateSessionUsage(this.range(args,"AND session_key=? ORDER BY at,id",[key])).sessions[0];
    this.db.exec("CREATE TEMP TABLE IF NOT EXISTS large_session_turns (id TEXT PRIMARY KEY, payload TEXT); DELETE FROM large_session_turns;");
    let lastAt=MIN,lastId="";
    let meta:TraceEntry|undefined;
    for(;;) {
      const page=[...this.range(args,"AND session_key=? AND (at,id)>(?,?) ORDER BY at,id LIMIT 256",[key,lastAt,lastId])];
      if(!page.length)break;
      this.db.transaction(()=>{for(const t of page){
        lastAt=t.at;lastId=t.id;if(!attempt(t))continue;
        meta??=t;meta.application??=t.application;meta.projectId??=t.projectId;meta.projectName??=t.projectName;
        const turnId=t.clientRequestId??t.id;
        const row=this.db.prepare("SELECT payload FROM large_session_turns WHERE id=?").get(turnId) as any;
        const turn=row?JSON.parse(row.payload):createTurn(t,turnId);
        addTraceToTurn(turn,t);
        this.db.prepare("INSERT OR REPLACE INTO large_session_turns VALUES (?,?)").run(turnId,JSON.stringify(turn));
      }})();
    }
    if(!meta)return;
    const field=(name:string)=>`json_extract(payload,'$.${name}')`;
    const count=(condition="1")=>(this.db.prepare(`SELECT count(*) AS n FROM large_session_turns WHERE ${condition}`).get() as any).n as number;
    const sum=(name:string)=>(this.db.prepare(`SELECT COALESCE(sum(${field(name)}),0) AS n FROM large_session_turns`).get() as any).n as number;
    const median=(name:string,condition="1")=>{const n=count(condition);if(!n)return undefined;return (this.db.prepare(`SELECT avg(value) AS n FROM (SELECT ${field(name)} AS value FROM large_session_turns WHERE ${condition} ORDER BY value LIMIT ? OFFSET ?)`).get(n%2?1:2,Math.floor((n-1)/2)) as any).n;};
    const turn=(condition:string,order:string)=>{const r=this.db.prepare(`SELECT payload FROM large_session_turns WHERE ${condition} ORDER BY ${field("at")} ${order},id ${order} LIMIT 1`).get() as any;return r?JSON.parse(r.payload):undefined;};
    const first=turn("1","ASC"),last=turn("1","DESC"),initial=turn(`${field("inputTokens")}>0`,"ASC"),final=turn(`${field("inputTokens")}>0`,"DESC");
    const models=(this.db.prepare(`SELECT ${field("model")} AS model,count(*) AS n FROM large_session_turns WHERE ${field("model")} IS NOT NULL GROUP BY model ORDER BY n DESC,model`).all() as any[]).map(r=>r.model);
    const measured=`${field("inputTokens")}>0`;
    const growthN=Math.max(0,count(measured)-1);
    const medianGrowth=growthN?(this.db.prepare(`SELECT avg(value) AS n FROM (SELECT value FROM (SELECT ${field("inputTokens")}-lag(${field("inputTokens")}) OVER (ORDER BY ${field("at")},id) AS value FROM large_session_turns WHERE ${measured}) WHERE value IS NOT NULL ORDER BY value LIMIT ? OFFSET ?)`).get(growthN%2?1:2,Math.floor((growthN-1)/2)) as any).n:undefined;
    const inputTokens=sum("inputTokens"),cachedInputTokens=sum("cachedInputTokens"),costUsd=sum("costUsd"),costUsdWithoutCache=sum("costUsdWithoutCache");
    return {sessionKey:key,application:meta.application,projectId:meta.projectId,projectName:meta.projectName,provider:last.provider,models,turns:count(),firstAt:first.at,lastAt:last.lastAt,durationMs:Math.max(0,last.lastAt-first.at),initialInputTokens:initial?.inputTokens,initialInputTokenBucket:ttftInputTokenBucket(initial?.inputTokens),inputTokens,cachedInputTokens,cacheWriteTokens:sum("cacheWriteTokens"),outputTokens:sum("outputTokens"),totalTokens:sum("totalTokens"),medianInputTokens:median("inputTokens",measured),maxInputTokens:initial?(this.db.prepare(`SELECT max(${field("inputTokens")}) AS n FROM large_session_turns`).get() as any).n:undefined,medianOutputTokens:median("outputTokens",measured),cachedInputRatio:inputTokens?Math.max(0,Math.min(1,cachedInputTokens/inputTokens)):undefined,cacheHitTurns:count(`${field("cachedInputTokens")}>0`),cacheMissTurns:count(`${field("inputTokens")}>0 AND ${field("cachedInputTokens")}=0`),cacheWriteTurns:count(`${field("cacheWriteTokens")}>0`),contextGrowthTokens:initial&&final?final.inputTokens-initial.inputTokens:undefined,medianTurnGrowthTokens:medianGrowth,errorTurns:count(`${field("isError")}=1`),costUsd,costUsdWithoutCache,cacheSavingsUsd:Math.max(0,costUsdWithoutCache-costUsd)};
  }

  sessions(args: Filter & { limit?: number; offset?: number }) {
    // Recompute only sessions touched since the last durable report for this window.
    // A rolling live window reuses its scope until its lower bound changes.
    const [since, until] = bounds(args);
    const scope = JSON.stringify([since, args.application ?? "", args.projectId ?? ""]);
    const previous = this.db.prepare("SELECT revision,until_ms FROM session_scopes WHERE scope=?").get(scope) as any;
    const rebuild = !previous || until < previous.until_ms;
    this.db.exec("CREATE TEMP TABLE IF NOT EXISTS changed_sessions (key TEXT PRIMARY KEY); DELETE FROM changed_sessions;");
    if (rebuild) {
      this.db.prepare("DELETE FROM session_reports WHERE scope=?").run(scope);
      this.db.prepare("INSERT OR IGNORE INTO changed_sessions SELECT DISTINCT session_key FROM entries WHERE at>=? AND at<=? AND session_key IS NOT NULL").run(since, until);
    } else {
      this.db.prepare("INSERT OR IGNORE INTO changed_sessions SELECT key FROM session_dirty WHERE revision>?").run(previous.revision);
      this.db.prepare("INSERT OR IGNORE INTO changed_sessions SELECT DISTINCT session_key FROM entries WHERE at>? AND at<=? AND session_key IS NOT NULL").run(Math.max(since-1, previous.until_ms), until);
    }
    let lastKey = "";
    for (;;) {
      const keys = this.db.prepare("SELECT key FROM changed_sessions WHERE key>? ORDER BY key LIMIT 256").all(lastKey) as {key:string}[];
      if (!keys.length) break;
      for (const {key} of keys) {
        lastKey = key;
      const session=this.sessionReport(args,key);
      if(session) this.db.prepare("INSERT OR REPLACE INTO session_reports VALUES (?,?,?,?,?,?)").run(scope,session.sessionKey,JSON.stringify(session),session.costUsd,session.turns,session.lastAt);
      else this.db.prepare("DELETE FROM session_reports WHERE scope=? AND key=?").run(scope,key);
    }
    }
    // Publish the revision only after all reports commit; interrupted refreshes are replayable.
    this.db.prepare("INSERT OR REPLACE INTO session_scopes VALUES (?,?,?,?)").run(scope,this.status.indexed,until,Date.now());
    for(const row of this.db.prepare("SELECT scope FROM session_scopes ORDER BY accessed DESC LIMIT -1 OFFSET 4").all() as any[]) {
      this.db.prepare("DELETE FROM session_reports WHERE scope=?").run(row.scope);
      this.db.prepare("DELETE FROM session_scopes WHERE scope=?").run(row.scope);
    }
    // Coverage uses the same incremental hourly rollups; no COUNT/JSON scan of lifetime history.
    let totalAttempts=0,attempts=0;
    const window=this.edgeAndHours(args);
    for(const row of this.db.prepare("SELECT payload FROM usage_buckets WHERE at>=? AND at<?").iterate(window.firstFull,window.fullEnd) as Iterable<any>) {
      const r:Rollup=JSON.parse(row.payload);if(!matches(r.meta,args))continue;
      totalAttempts+=r.usage.requests;attempts+=r.sessionAttempts;
    }
    for(const t of window.edge) {if(!attempt(t))continue;totalAttempts++;if(sessionKeyOf(t))attempts++;}
    const field = (name: string) => `json_extract(payload,'$.${name}')`;
    const sum = (name: string) => (this.db.prepare(`SELECT COALESCE(sum(${field(name)}),0) AS n FROM session_reports WHERE scope=?`).get(scope) as any).n as number;
    const median = (name: string) => {
      const n = (this.db.prepare(`SELECT count(*) AS n FROM session_reports WHERE scope=? AND ${field(name)} IS NOT NULL`).get(scope) as any).n;
      if (!n) return undefined;
      return (this.db.prepare(`SELECT avg(value) AS n FROM (SELECT ${field(name)} AS value FROM session_reports WHERE scope=? AND ${field(name)} IS NOT NULL ORDER BY value LIMIT ? OFFSET ?)`).get(scope, n % 2 ? 1 : 2, Math.floor((n - 1)/2)) as any).n as number;
    };
    const total = (this.db.prepare("SELECT count(*) AS n FROM session_reports WHERE scope=?").get(scope) as any).n;
    const buckets: Record<string, number> = { lt1k: 0, "1k-8k": 0, "8k-32k": 0, "32k-64k": 0, "64k-128k": 0, "128k-plus": 0, unknown: 0 };
    for (const r of this.db.prepare(`SELECT ${field("initialInputTokenBucket")} AS key, count(*) AS n FROM session_reports WHERE scope=? GROUP BY 1`).all(scope) as any[]) buckets[r.key] = r.n;
    const turns=sum("turns"), inputTokens=sum("inputTokens"), cachedInputTokens=sum("cachedInputTokens"), cacheHitTurns=sum("cacheHitTurns");
    const summary = { sessions: total, turns, attempts, totalAttempts, coverage: totalAttempts ? attempts/totalAttempts : 0, initialInputTokensMedian: median("initialInputTokens"), initialInputTokenBuckets: buckets, turnsPerSessionMedian: median("turns") ?? 0, cachedInputRatio: inputTokens ? Math.max(0,Math.min(1,cachedInputTokens/inputTokens)) : undefined, cacheHitTurns, cacheHitRatio: turns ? cacheHitTurns/turns : 0, inputTokens, cachedInputTokens, cacheWriteTokens: sum("cacheWriteTokens"), outputTokens: sum("outputTokens"), costUsd: sum("costUsd"), cacheSavingsUsd: sum("cacheSavingsUsd") };
    const sessions = (this.db.prepare("SELECT payload FROM session_reports WHERE scope=? ORDER BY cost DESC, turns DESC, last_at DESC, key LIMIT ? OFFSET ?").all(scope, Math.max(1,Math.min(500,args.limit ?? 100)), Math.max(0,args.offset ?? 0)) as any[]).map(r=>JSON.parse(r.payload));
    return { summary, total, sessions };
  }

  private turns(args: Filter & {sessionKey:string;limit?:number;offset?:number}) {
    const [since,until]=bounds(args);
    const limit=Math.max(1,Math.min(500,Math.floor(args.limit??200)));
    const offset=Math.max(0,Math.floor(args.offset??0));
    const clause="session_key=? AND at>=? AND at<=? AND (kind IS NULL OR kind='upstream-attempt')";
    const total=(this.db.prepare(`SELECT count(DISTINCT turn_id) AS n FROM entries WHERE ${clause}`).get(args.sessionKey,since,until) as any).n;
    const keys=this.db.prepare(`SELECT turn_id FROM entries WHERE ${clause} GROUP BY turn_id ORDER BY min(at),turn_id LIMIT ? OFFSET ?`).all(args.sessionKey,since,until,limit,offset) as {turn_id:string}[];
    const turns=[];
    for(const {turn_id} of keys) turns.push(...sessionTurnsFor(this.range(args,"AND session_key=? AND turn_id=? ORDER BY at,id",[args.sessionKey,turn_id]),args.sessionKey));
    return {turns,total,limit,offset};
  }

  query(action: string, args: any): any {
    if (action === "append") { this.append(args.entries); return; }
    if (action === "status") return this.status;
    if (action === "recent") return (this.db.prepare("SELECT payload FROM recent ORDER BY seq").all() as any[]).map(r=>JSON.parse(r.payload));
    if (action === "trace") { const row=this.db.prepare("SELECT payload FROM recent WHERE id=?").get(args.id) as any; return row ? JSON.parse(row.payload) : null; }
    if (action === "range") return [...this.range(args)];
    const key = JSON.stringify([action,args]); const cached = this.cache.get(key);
    if (cached && cached.generation === this.generation && cached.expires > Date.now()) return cached.value;
    let value: any;
    if (action === "stats") value=this.stats(args);
    else if (action === "usage") value=this.usage(args);
    else if (action === "sessions") value=this.sessions(args);
    else if (action === "turns") value=this.turns(args);
    else if (action === "anonymous") {
      const totals=new Map<string,number>();
      for(const row of this.db.prepare("SELECT payload FROM entries WHERE completed_at>=? AND completed_at<?").iterate(args.sinceMs,args.untilMs) as Iterable<any>) { const t:TraceEntry=JSON.parse(row.payload); if(t.lifecycleState!=="completed" || t.isError) continue; const model=args.modelAllowlist[t.requestedModel ?? t.model ?? ""]; if(!model)continue; const n=Math.max(0,Math.floor(t.tokensOutput??0)); if(n)totals.set(model,Math.min(1_000_000_000,(totals.get(model)??0)+n)); }
      value=[...totals].map(([modelId,outputTokens])=>({modelId,outputTokens})).sort((a,b)=>b.outputTokens-a.outputTokens||a.modelId.localeCompare(b.modelId));
    } else if (action === "community") {
      value=[];for(const row of this.db.prepare("SELECT payload FROM entries WHERE completed_at>=? AND completed_at<? ORDER BY completed_at").iterate(args.sinceMs,args.untilMs) as Iterable<any>) { const t=JSON.parse(row.payload);if(t.lifecycleState!=="completed"|| !["local","personal-cluster"].includes(t.executionLocation))continue; const {lifecycleState,isError,provider,model,requestedModel,resolvedModel,executionLocation,latencyMs,ttftMs,tokensInput,tokensOutput,tokensInputCached,tokensReasoning}=t;value.push({lifecycleState,isError,provider,model,requestedModel,resolvedModel,executionLocation,latencyMs,ttftMs,tokensInput,tokensOutput,tokensInputCached,tokensReasoning});if(value.length>=args.limit)break; }
    } else throw new Error(`Unknown analytics query: ${action}`);
    if (this.cache.size >= 8) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key,{generation:this.generation,expires:Date.now()+5000,value});return value;
  }

  async close() { this.stopped=true; await this.scanning; this.db.pragma("wal_checkpoint(TRUNCATE)"); this.db.close(); }
}
