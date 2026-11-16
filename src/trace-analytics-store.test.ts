import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TraceAnalyticsStore } from "./trace-analytics-store.js";
import { createTraceManager, normalizeTrace, toStatsHistoryEntry, buildTraceStats, createUsageAggregate, addTraceToAggregate, finalizeAggregate, type TraceEntry } from "./traces.js";
import { aggregateSessionUsage, sessionTurnsFor } from "./session-usage.js";
import { sessionKeyOf } from "./session-identity.js";
import { aggregateProjectUsage } from "./project-usage.js";
import { installModelsDevPricing } from "./model-pricing.js";

const BASE = 1_790_000_000_000;
function trace(id: string, at=BASE): TraceEntry {
  return { id, at, completedAt: at+10, route: "/responses", status: 200, isError: false, stream: true, lifecycleState: "completed", latencyMs: 100, ttftMs: 20,
    model: "gpt-4o-mini", provider: "openai", usageStatus: "measured", tokensInput: 20, tokensInputCached: 10, tokensOutput: 5, tokensTotal: 25,
    application: "codex", codexSessionId: "session-one", clientRequestId: id, projectId: "project-one", costUsd: 0.1 };
}
async function fixture(t: test.TestContext) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"multivibe-index-"));
  const config={dbPath:path.join(dir,"stats.sqlite"),historyFilePath:path.join(dir,"history.jsonl"),filePath:path.join(dir,"journal.jsonl"),externalWriter:true,retentionMax:3};
  let store=await TraceAnalyticsStore.open(config);
  t.after(async()=>{await store.close();await fs.rm(dir,{recursive:true,force:true});});
  return {config,get store(){return store;},async reopen(){await store.close();store=await TraceAnalyticsStore.open(config);return store;}};
}
const lines=(records:TraceEntry[])=>records.map(t=>JSON.stringify(t)).join("\n")+"\n";

test("models.dev backfills absent costs once, preserves recorded/free costs and rebuilds reports", async t => {
  const f = await fixture(t);
  f.config.retentionMax = 10;
  const missing = { ...trace("missing"), model: "future-sol", costUsd: undefined, costStatus: "unpriced" as const,
    tokensInput: 100000, tokensInputCached: 20000, tokensOutput: 10000 };
  f.store.append([missing, { ...missing, id: "recorded", costUsd: 0.7 }, { ...missing, id: "free", costUsd: 0 },
    { ...missing, id: "unknown", model: "unpublished" }, { ...missing, id: "no-usage", usageStatus: "missing" }], undefined, true);
  f.store.sessions({}); // Materialize the old report before correcting the history.
  installModelsDevPricing({ openai: [{ id: "future-sol", cost: { input: 2, output: 10, cache_read: 0.1 } }] }, BASE);
  t.after(() => installModelsDevPricing({}, BASE));
  f.store.enablePricingBackfill();
  await f.store.sync();
  const records = f.store.query("range", {}) as TraceEntry[];
  const priced = records.find(r => r.id === "missing")!;
  assert.ok(Math.abs(priced.costUsd! - 0.262) < 1e-12);
  assert.equal(priced.costStatus, "estimated");
  assert.match(priced.pricingVersion!, /^models.dev:/);
  assert.equal(records.find(r => r.id === "recorded")!.costUsd, 0.7);
  assert.equal(records.find(r => r.id === "free")!.costUsd, 0);
  assert.equal(records.find(r => r.id === "unknown")!.costUsd, undefined);
  assert.equal(records.find(r => r.id === "no-usage")!.costUsd, undefined);
  assert.equal(f.store.status.pricingBackfill?.updated, 1);
  const total = f.store.stats({}).stats.totals.costUsd;
  assert.ok(Math.abs(total - 0.962) < 1e-12);
  assert.ok(Math.abs(f.store.sessions({}).sessions[0].costUsd - total) < 1e-12);
  assert.ok(Math.abs(f.store.query("trace", { id: "missing" }).costUsd - 0.262) < 1e-12);
  await f.reopen();
  installModelsDevPricing({ openai: [{ id: "future-sol", cost: { input: 100, output: 100 } },
    { id: "unpublished", cost: { input: 1, output: 1 } }] }, BASE + 1);
  f.store.enablePricingBackfill();
  await f.store.sync();
  const after = f.store.query("range", {}) as TraceEntry[];
  assert.equal(after.find(r => r.id === "missing")!.costUsd, priced.costUsd);
  assert.equal(after.find(r => r.id === "unknown")!.costUsd, undefined, "a later catalog does not trigger a second backfill");
  assert.equal(f.store.status.pricingBackfill?.updated, 1);
  assert.equal(f.store.status.pricingBackfill?.state, "complete");
  assert.ok(Math.abs(f.store.sessions({}).sessions[0].costUsd - total) < 1e-12, "report rebuilds preserve the migration result after a price change");
  f.store.append([missing, { ...missing, id: "unknown", model: "unpublished" }], undefined, true);
  assert.equal(f.store.query("trace", { id: "missing" }).costUsd, priced.costUsd, "journal replay preserves recorded costs");
  assert.equal(f.store.query("trace", { id: "unknown" }).costUsd, undefined, "journal replay preserves the one-time unknown result");
});

test("interrupted cost backfill resumes committed batches and rebuilds affected hours", async t => {
  const f = await fixture(t);
  f.store.append(Array.from({ length: 1005 }, (_, i) => ({ ...trace(`backfill-${i}`), model: "future-resume", costUsd: undefined })));
  installModelsDevPricing({ openai: [{ id: "future-resume", cost: { input: 2, output: 10 } }] }, BASE);
  t.after(() => installModelsDevPricing({}, BASE));
  // Finish import IO first, then interrupt at the first migration batch yield.
  f.config.externalWriter = false;
  await f.store.sync();
  f.store.enablePricingBackfill();
  const closing = new Promise<void>((resolve, reject) => setImmediate(() => { f.store.close().then(resolve, reject); }));
  const syncing = f.store.sync();
  await Promise.all([syncing, closing]);
  assert.equal(f.store.status.pricingBackfill?.state, "running");
  assert.equal(f.store.status.pricingBackfill?.updated, 1000);
  await f.reopen();
  f.store.enablePricingBackfill();
  await f.store.sync();
  assert.equal(f.store.status.pricingBackfill?.updated, 1005);
  assert.equal(f.store.status.pricingBackfill?.state, "complete");
  assert.equal(f.store.stats({}).stats.totals.requests, 1005);
  assert.ok(Math.abs(f.store.stats({}).stats.totals.costUsd - 1005 * 0.00009) < 1e-12);
});

test("indexed migration/restart and journal rotation preserve exact counts and bounded recent traces",async t=>{
  const f=await fixture(t);
  const records=Array.from({length:2100},(_,i)=>trace(`id-${i}`,BASE+i));
  await fs.writeFile(f.config.historyFilePath,lines(records.slice(0,2000)));
  await fs.writeFile(f.config.filePath,lines(records));
  await f.store.sync();
  assert.equal(f.store.status.indexed,2100);
  assert.equal(f.store.query("recent",{}).length,3);
  assert.equal(f.store.stats({}).stats.totals.tokensTotal,2100*25);
  await f.reopen();await f.store.sync();assert.equal(f.store.status.indexed,2100);
  await fs.rename(f.config.filePath,`${f.config.filePath}.previous`);
  await fs.writeFile(f.config.filePath,lines([trace("new-one")]));
  await f.store.sync();
  assert.equal(f.store.status.indexed,2101);
  await assert.rejects(fs.stat(`${f.config.filePath}.previous`),{code:"ENOENT"});
  assert.equal(f.store.query("trace",{id:"new-one"}).id,"new-one");
  const recent=f.store.query("recent",{});
  assert.ok(recent.length<=3);
});

test("time boundaries, filters, usage and retry/session semantics match existing implementations",async t=>{
  const f=await fixture(t);
  const hour=Math.floor(BASE/3_600_000)*3_600_000;
  const records=[trace("before",hour+1),trace("inside",hour+100),trace("hour2",hour+3_600_000),trace("hour3",hour+7_200_000),
    {...trace("retry",hour+102),isError:true,status:429,clientRequestId:"inside"},
    {...trace("client",hour+103),traceKind:"client-request" as const},
    {...trace("outside",hour+8_000_000),application:"other",projectId:"other"}];
  const canonical=records.map(t=>normalizeTrace(toStatsHistoryEntry(t))!);
  f.store.append(records);
  for(const filter of [{},{sinceMs:hour+100,untilMs:hour+7_200_000},{sinceMs:hour+101,untilMs:hour+101},{sinceMs:hour+7_200_001}]){
    const selected=canonical.filter(t=>(filter.sinceMs===undefined||t.at>=filter.sinceMs)&&(filter.untilMs===undefined||t.at<=filter.untilMs));
    const actual=f.store.stats(filter).stats,expected=buildTraceStats(selected);
    assert.equal(actual.totals.tokensTotal,expected.totals.tokensTotal);
    assert.equal(actual.totals.requests,expected.totals.requests);
    assert.equal(actual.totals.errors,expected.totals.errors);
    const report=f.store.sessions({...filter,limit:1});const legacy=aggregateSessionUsage(selected);
    assert.deepEqual(report.summary,legacy.summary);
    assert.deepEqual(report.sessions,JSON.parse(JSON.stringify(legacy.sessions.slice(0,1))));assert.equal(report.total,legacy.sessions.length);
  }
  const filter={sinceMs:hour+100,untilMs:hour+7_200_000,application:"codex",projectId:"project-one"};
  const selected=canonical.filter(t=>t.at>=filter.sinceMs&&t.at<=filter.untilMs&&(!t.traceKind||t.traceKind==="upstream-attempt"));
  const agg=createUsageAggregate();selected.forEach(t=>addTraceToAggregate(agg,t));
  const usage=f.store.usage(filter);
  assert.deepEqual(usage.totals,finalizeAggregate(agg));
  assert.deepEqual(usage.byProject,aggregateProjectUsage(selected));
  const sessionKey=aggregateSessionUsage(canonical).sessions[0].sessionKey;
  assert.deepEqual(f.store.query("turns",{sessionKey}).turns,sessionTurnsFor(canonical,sessionKey));
});

test("split UTF-8, invalid lines and truncated journal never advance past an incomplete record",async t=>{
  const f=await fixture(t);const first=trace("étoile");const buffer=Buffer.from(lines([first]));
  await fs.writeFile(f.config.filePath,buffer.subarray(0,buffer.length-2));
  await f.store.sync();assert.equal(f.store.status.indexed,0);
  await fs.appendFile(f.config.filePath,buffer.subarray(buffer.length-2));
  await f.store.sync();assert.equal(f.store.status.indexed,1);
  await fs.appendFile(f.config.filePath,"broken\n"+lines([trace("second")]));
  await f.store.sync();assert.equal(f.store.status.indexed,2);assert.equal(f.store.status.invalidLines,1);
  await fs.writeFile(f.config.filePath,lines([trace("third")]));
  await f.store.sync();assert.equal(f.store.status.indexed,3);
});

test("worker RPC queries remain independent from synchronous HTTP-thread storage",async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"multivibe-worker-"));
  const filePath=path.join(dir,"journal.jsonl"),historyFilePath=path.join(dir,"history.jsonl");
  await fs.writeFile(historyFilePath,lines([trace("existing")]));
  const manager=createTraceManager({filePath,historyFilePath,indexedHistoryPath:path.join(dir,"index.sqlite"),externalWriter:true});
  t.after(async()=>{await manager.close();await fs.rm(dir,{recursive:true,force:true});});
  await manager.initialize();
  await manager.queryAnalytics!("sync",{});
  const results=await Promise.all(Array.from({length:10},()=>manager.getTraceStats()));
  assert.ok(results.every(result=>result.stats.totals.requests===1));
  assert.equal(manager.getPersistenceStatus().analytics?.ready,true);
});

test("oversized sessions spill to disk while preserving turn medians, growth and retry costs",async t=>{
  const f=await fixture(t);
  const records=Array.from({length:10002},(_,i)=>({...trace(`large-${i}`,BASE+i),tokensInput:20+i,clientRequestId:`turn-${i}`}));
  for(let i=0;i<records.length;i+=1000)f.store.append(records.slice(i,i+1000));
  const actual=f.store.sessions({limit:1}).sessions[0];
  const expected=aggregateSessionUsage(records.map(t=>normalizeTrace(toStatsHistoryEntry(t))!)).sessions[0];
  for(const field of ["costUsd","costUsdWithoutCache","cacheSavingsUsd"] as const) {
    assert.ok(Math.abs(actual[field]-expected[field])<1e-8);
    actual[field]=expected[field];
  }
  assert.deepEqual(actual,JSON.parse(JSON.stringify(expected)));
  const page=f.store.query("turns",{sessionKey:actual.sessionKey,limit:10,offset:500});
  assert.equal(page.total,10002);assert.equal(page.turns.length,10);assert.equal(page.turns[0].clientRequestId,"turn-500");
});


test("analytics database and SQLite sidecars keep private permissions", async t => {
  const f=await fixture(t);
  for (const suffix of ["", "-wal", "-shm"]) {
    const info=await fs.stat(f.config.dbPath+suffix);
    assert.equal(info.mode & 0o777,0o600);
  }
});

test("large session turn state updates incrementally, including late retries after restart",async t=>{
  const f=await fixture(t);
  const records=Array.from({length:10002},(_,i)=>trace(`delta-${i}`,BASE+i));
  for(let i=0;i<records.length;i+=1000)f.store.append(records.slice(i,i+1000));
  const until=BASE+20000;
  assert.equal(f.store.sessions({untilMs:until}).summary.turns,10002);
  const added={...trace('new-delta',BASE+10003),clientRequestId:'new-delta'};
  f.store.append([added]);
  assert.equal(f.store.sessions({untilMs:until+1}).summary.turns,10003);
  await f.reopen();
  const late={...trace('late-delta',BASE+1),clientRequestId:'delta-1'};
  f.store.append([late]);
  const report=f.store.sessions({untilMs:until+2});
  const expected=aggregateSessionUsage([...records,added,late].map(t=>normalizeTrace(toStatsHistoryEntry(t))!));
  assert.equal(report.summary.turns,expected.summary.turns);
  assert.equal(report.summary.inputTokens,expected.summary.inputTokens);
  assert.ok(Math.abs(report.summary.costUsd-expected.summary.costUsd)<1e-8);
  assert.deepEqual(report.summary.initialInputTokenBuckets,expected.summary.initialInputTokenBuckets);
});

test("API key attribution: byApiKey, filters and legacy schema upgrade", async t => {
  const f = await fixture(t);
  f.config.retentionMax = 20;
  const at = BASE + 3_600_000;
  const a = { ...trace("key-a", at), apiKeyId: "configured:codex", apiKeyPreview: "mv_first••••abcd" };
  const b = { ...trace("key-b", at), apiKeyId: "configured:codex", apiKeyPreview: "mv_first••••abcd", tokensOutput: 9, tokensTotal: 29, costUsd: 0.2 };
  const c = { ...trace("key-c", at), apiKeyId: "11111111-2222-4333-8444-555555555555", apiKeyPreview: "mv_second••••wxyz", application: "harness-opencode" };
  const keyless = { ...trace("key-none", at), apiKeyId: undefined };
  f.store.append([a, b, c, keyless], undefined, true);

  const usage = f.store.usage({});
  const byKey = new Map(usage.byApiKey.map((entry: any) => [entry.apiKeyId, entry]));
  assert.equal(byKey.get("configured:codex").requests, 2, "attempts from one key aggregate together");
  assert.equal(byKey.get("configured:codex").keyPreview, "mv_first••••abcd");
  assert.equal(byKey.get("configured:codex").application, "codex");
  assert.equal(byKey.get("11111111-2222-4333-8444-555555555555").requests, 1);
  assert.equal(byKey.get("11111111-2222-4333-8444-555555555555").application, "harness-opencode");
  assert.equal(byKey.get("unattributed").requests, 1, "keyless calls stay visible");
  // Key rows must expose the project-grade money and percentile dimensions.
  for (const field of ["costUsd", "requestsWithCost", "unpricedRequests", "avgLatencyMs", "latencyP50Ms", "latencyP95Ms", "firstAt", "lastAt"]) {
    assert.ok(field in byKey.get("configured:codex"), `byApiKey exposes ${field}`);
  }
  assert.ok(Math.abs(byKey.get("configured:codex").costUsd - 0.3) < 1e-12);
  assert.equal(byKey.get("unattributed").application, undefined, "unattributed is not an application");
  const summedCost = (usage.byApiKey as any[]).reduce((sum, entry) => sum + entry.costUsd, 0);
  const byProjectCost = (usage.byProject as any[]).reduce((sum, entry) => sum + entry.costUsd, 0);
  assert.ok(Math.abs(summedCost - byProjectCost) < 1e-9, "per-key costs reconcile with the project range total");

  // Aggregated hourly rollups must honour the narrowing filter, not just raw edges.
  const filtered = f.store.usage({ apiKeyId: "configured:codex" });
  assert.equal(filtered.totals.requests, 2);
  assert.equal((filtered as any).byApiKey.length, 1);
  const exactHour = f.store.usage({ sinceMs: at, untilMs: at + 60_000, apiKeyId: "11111111-2222-4333-8444-555555555555" });
  assert.equal(exactHour.totals.requests, 1);
  assert.equal(f.store.sessions({ apiKeyId: "configured:codex" }).sessions.length, 1);
  assert.equal(f.store.sessions({ apiKeyId: "11111111-2222-4333-8444-555555555555" }).sessions.length, 1);

  // Reopening an older database shape must add the column without losing rows.
  await f.reopen();
  assert.equal((f.store.usage({}).byApiKey as any[]).length, 3);
  assert.equal(f.store.usage({ apiKeyId: "configured:codex" }).totals.requests, 2);
});

test("key-filtered trace stats stay bounded to the key and exclude other keys", async t => {
  const f = await fixture(t);
  f.config.retentionMax = 20;
  // Complete hours (not edge hours): these only resolve through hourly rollups.
  const hour = Math.floor(BASE / 3_600_000) * 3_600_000 + 3_600_000;
  const keyed = { ...trace("hour-a", hour + 1_000), apiKeyId: "configured:codex", apiKeyPreview: "mv_a••••1111" };
  const other = { ...trace("hour-b", hour + 2_000), apiKeyId: "configured:other", apiKeyPreview: "mv_b••••2222" };
  const keyless = { ...trace("hour-c", hour + 3_000), apiKeyId: undefined };
  f.store.append([keyed, other, keyless], undefined, true);

  const narrow = { sinceMs: hour, untilMs: hour + 3_600_000 - 1 };
  assert.equal(f.store.stats({ ...narrow, apiKeyId: "configured:codex" }).stats.totals.requests, 1);
  assert.equal(f.store.stats(narrow).stats.totals.requests, 3);
  assert.equal(f.store.stats({ ...narrow, apiKeyId: "configured:other" }).stats.totals.requests, 1);
  // The key filter must not leak another key's cost or tokens.
  const filtered = f.store.usage({ ...narrow, apiKeyId: "configured:codex" });
  assert.equal(filtered.totals.requests, 1);
  assert.equal((filtered as any).byApiKey.length, 1);

  // Session turns must honour the same narrowing, including their total count.
  const sessionKey = sessionKeyOf(keyed)!;
  const allTurns = f.store.query("turns", { ...narrow, sessionKey, limit: 50 }) as { total: number; turns: any[] };
  const ownTurns = f.store.query("turns", { ...narrow, sessionKey, apiKeyId: "configured:codex", limit: 50 }) as { total: number; turns: any[] };
  const otherTurns = f.store.query("turns", { ...narrow, sessionKey, apiKeyId: "configured:ghost", limit: 50 }) as { total: number; turns: any[] };
  // The fixture shares one Codex session across keys, so the unfiltered session
  // has one turn per key while each key sees only its own.
  assert.equal(allTurns.total, 3);
  assert.equal(ownTurns.total, 1);
  assert.equal(ownTurns.turns.length, 1);
  assert.equal(ownTurns.turns[0].clientRequestId, "hour-a", "only the selected key's turn is returned");
  assert.equal(otherTurns.total, 0, "a foreign key reports no turns");
  assert.equal(otherTurns.turns.length, 0);
});

test("legacy history without per-key buckets is rebuilt once by the backfill", async t => {
  const f = await fixture(t);
  f.config.retentionMax = 20;
  const hour = Math.floor(BASE / 3_600_000) * 3_600_000 + 7_200_000;
  f.store.append([
    { ...trace("bf-a", hour + 1_000), apiKeyId: "configured:legacy", apiKeyPreview: "mv_l••••9999" },
    { ...trace("bf-b", hour + 2_000), apiKeyId: "configured:legacy", apiKeyPreview: "mv_l••••9999" },
  ], undefined, true);
  // Simulate a database produced before the per-key buckets existed.
  (f.store as any).db.prepare("DELETE FROM buckets_by_key").run();
  (f.store as any).db.prepare("DELETE FROM metadata WHERE key=?").run("api-key-buckets-2026-11-16-v1");
  await f.reopen();
  assert.equal(f.store.status.keyBucketBackfill?.state, "running");
  await f.store.sync();
  assert.equal(f.store.status.keyBucketBackfill?.state, "complete");
  const narrow = { sinceMs: hour, untilMs: hour + 3_600_000 - 1, apiKeyId: "configured:legacy" };
  assert.equal(f.store.stats(narrow).stats.totals.requests, 2);
  // A second sync is a no-op, not a re-scan.
  const scanned = f.store.status.keyBucketBackfill?.scanned;
  await f.store.sync();
  assert.equal(f.store.status.keyBucketBackfill?.scanned, scanned);
});
