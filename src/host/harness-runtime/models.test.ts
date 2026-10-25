import assert from "node:assert/strict";
import test from "node:test";
import { harnessModels } from "./models.js";

test("native catalogs normalize ACP, config options, Pi, Codex, Claude and remote chat identifiers",()=>{
  for(const value of [
    {models:{availableModels:[{modelId:"exact-id",name:"Display"}]}},
    {configOptions:[{category:"model",options:[{group:"Provider",options:[{value:"exact-id",name:"Display"}]}]}]},
    {models:[{id:"exact-id",name:"Display"}]},
    {data:[{model:"exact-id",displayName:"Display"}]},
    [{value:"exact-id",displayName:"Display"}],
  ])assert.deepEqual(harnessModels(value),[{id:"exact-id",name:"Display"}]);
  assert.deepEqual(harnessModels({}),[]);
  assert.deepEqual(harnessModels({models:[{id:"same",provider:"one"},{id:"same",provider:"two"},{id:"same",provider:"one"}]}).map(v=>v.provider),["one","two"]);
});
test("OpenCode exposes only connected providers and keeps exact provider/model routes",()=>{
  const value={connected:["connected"],all:[{id:"offline",models:{wrong:{name:"Wrong"}}},{id:"connected",name:"Provider",models:{"exact-model":{name:"Model"}}}]};
  assert.deepEqual(harnessModels(value),[{id:"connected/exact-model",name:"Model",description:"Provider"}]);
});
