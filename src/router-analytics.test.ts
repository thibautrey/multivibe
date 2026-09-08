import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModuleStorageManager } from "./module-storage.js";
import { recordRouterDecision, recordRouterUsage } from "./router-analytics.js";
import type { ModuleContext } from "./module-sdk.js";

test("router analytics use measured usage, preserve negative differences and ignore unpriced claims", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "router-analytics-"));
  const manager = new ModuleStorageManager(root);
  const context: ModuleContext = { requestId:"request", route:"/responses",transport:"http",settings:{},signal:new AbortController().signal,
    storage:manager.forPlugin("test.router"),log:{info(){},warn(){},error(){}} };
  try {
    await recordRouterDecision({model:"gpt-4o-mini"}, {action:"replace",value:{model:"gpt-4o"}}, context, "classified");
    const trace = {traceId:"trace",traceKind:"upstream-attempt",model:"gpt-4o",status:200,usageStatus:"measured",tokensInput:1000,tokensOutput:100,tokensInputCached:500};
    await recordRouterUsage(trace,context); await recordRouterUsage(trace,context);
    const summary = manager.summary("test.router");
    assert.equal(summary.types["routing.usage"].count,1);
    assert.ok(summary.types["routing.usage"].metrics.grossSavingsUsd < 0);
    await recordRouterUsage({...trace,traceId:"unknown",model:"unpriced-model"},context);
    await recordRouterUsage({...trace,traceId:"missing",usageStatus:"missing"},context);
    assert.equal(manager.summary("test.router").types["routing.usage"].metrics.unknown,2);
    assert.equal((await context.storage!.readEvents("routing.decision"))[0].data && JSON.stringify((await context.storage!.readEvents())).includes("messages"),false);
  } finally {manager.close();await fs.rm(root,{recursive:true,force:true});}
});

test("virtual-model savings retain the advanced-model baseline from routing time", async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"virtual-router-analytics-"));
  const manager=new ModuleStorageManager(root);
  const context:ModuleContext={requestId:"virtual",route:"/responses",transport:"http",settings:{advancedModel:"gpt-4o"},signal:new AbortController().signal,
    storage:manager.forPlugin("test.router"),log:{info(){},warn(){},error(){}}};
  try {
    await recordRouterDecision({model:"multivibe/autorouter"},{action:"replace",value:{model:"gpt-4o-mini"}},context,"classified");
    context.settings={advancedModel:"unpriced"};
    await recordRouterUsage({traceId:"virtual-trace",traceKind:"upstream-attempt",model:"gpt-4o-mini",status:200,usageStatus:"measured",tokensInput:1000,tokensOutput:100},context);
    assert.equal(manager.summary("test.router").types["routing.usage"].metrics.comparable,1);
    assert.ok(manager.summary("test.router").types["routing.usage"].metrics.grossSavingsUsd>0);
  } finally {manager.close();await fs.rm(root,{recursive:true,force:true});}
});
