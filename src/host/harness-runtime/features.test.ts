import assert from "node:assert/strict";
import test from "node:test";
import { harnessFeatures } from "./features.js";

test("feature catalog normalizes every advertised section without returning raw settings",()=>{
  const capabilities:any={compaction:{available:true,support:"native"},memory:{available:true,support:"native"},sessions:{available:true,support:"native"}};
  const inspected={
    modes:{data:[{id:"plan",name:"Plan",description:"Plan first"},{id:"default",name:"Default"}]},commands:[{name:"/review",description:"Review code"}],
    skills:{data:[{skills:[{name:"documents",description:"Create documents"}]}]},plugins:{secret:"must-not-return",plugins:[{id:"pdf",name:"PDF"}]},
    agents:[{name:"explorer"}],tools:["shell"],mcp:{servers:{github:{name:"GitHub"}}},hooks:[{name:"After turn"}],
  };
  const items=harnessFeatures("openai-codex",capabilities,inspected);
  assert.ok(["actions","modes","commands","skills","plugins","agents","tools","mcp","hooks","capabilities"].every(section=>items.some(v=>v.section===section)));
  assert.equal(items.find(v=>v.section==="skills")?.value,"$documents ");
  assert.equal(items.find(v=>v.section==="commands")?.value,"/review ");
  assert.equal(items.find(v=>v.section==="modes")?.action,"configure");
  assert.equal(JSON.stringify(items).includes("must-not-return"),false);
});
