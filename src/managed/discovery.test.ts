import test from "node:test";
import assert from "node:assert/strict";
import { ManagedDiscovery } from "./discovery.js";
test("discovery proves the execution account, deduplicates concurrent probes and sanitizes failures", async () => {
  let probes=0;
  const discovery=new ManagedDiscovery([
    {providerId:"mistral",credentialRef:"account-1",models:new Set(["configured"]),async chatCompletions(){throw Error("must not infer")},
      async discoverModels(){probes++;return["configured","new-model"]}},
    {providerId:"xai",credentialRef:"account-2",models:new Set(["other"]),async chatCompletions(){throw Error("must not infer")},
      async discoverModels(){throw Error("secret provider response")}},
  ],()=>1000);
  const values=await Promise.all([discovery.read(),discovery.read()]);
  assert.deepEqual(values[0],values[1]);assert.equal(probes,1);
  const result=values[0] as {accounts:Array<{status:string;models:string[];executableModels:string[]}>};
  assert.deepEqual(result.accounts[0]?.models,["configured","new-model"]);
  assert.deepEqual(result.accounts[0]?.executableModels,["configured"]);
  assert.equal(result.accounts[1]?.status,"unavailable");
  assert.doesNotMatch(JSON.stringify(result),/secret provider response/);
});
