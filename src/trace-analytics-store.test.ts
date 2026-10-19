import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TraceAnalyticsStore } from "./trace-analytics-store.js";
import { createTraceManager, normalizeTrace, toStatsHistoryEntry, buildTraceStats, createUsageAggregate, addTraceToAggregate, finalizeAggregate, type TraceEntry } from "./traces.js";
import { aggregateSessionUsage, sessionTurnsFor } from "./session-usage.js";
import { aggregateProjectUsage } from "./project-usage.js";

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
  assert.deepEqual(f.store.query("turns",{sessionKey}),sessionTurnsFor(canonical,sessionKey));
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
