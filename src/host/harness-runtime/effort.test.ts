import assert from "node:assert/strict";
import test from "node:test";
import { acpEffort, effortOptions, validateEffort } from "./effort.js";

test("effort metadata preserves harness values, labels and grouped ACP choices",()=>{
  assert.deepEqual(effortOptions([{reasoningEffort:"future",description:"Native level"},"off",null,"off"],"future"),{options:[{value:"future",label:"future",description:"Native level"},{value:"off",label:"off"}],currentValue:"future"});
  assert.equal(effortOptions([]),null);
  assert.deepEqual(acpEffort({configOptions:[{id:"private-setting",type:"select",category:"thought_level",currentValue:"custom",options:[{group:"Native",options:[{value:"custom",name:"Deep"}]}]}]}),{id:"private-setting",effort:{options:[{value:"custom",label:"Deep"}],currentValue:"custom"}});
  assert.equal(acpEffort({configOptions:[{id:"temperature",type:"select",options:[{value:"high"}]}]}),null);
  assert.throws(()=>validateEffort(null,"high"),/not advertised/);
});
