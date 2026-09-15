import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localMemoryBudget,exceedsWeightBudget} from './model-memory-budget.js';
import {rankOpenModels} from './open-model-ranking.js';
import {parseOpenModels} from './open-model-catalog.js';
test('64 GiB Mac reserves memory and rejects oversized weights without claiming smaller ones fit',()=>{
 const memory=localMemoryBudget(64*1024**3);
 assert.equal(memory.totalHostMiB,65536);assert.equal(memory.budgetMiB,49152);
 assert.equal(localMemoryBudget(64*1024**3,1024**2).budgetMiB,65536*.9);
 assert.equal(exceedsWeightBudget(110.97*1024**3,memory),true);
 assert.equal(exceedsWeightBudget(null,memory),false);
 assert.equal(exceedsWeightBudget(16*1024**3,memory),false);
 const models=parseOpenModels([{id:'owner/huge',private:false,gated:false,pipeline_tag:'text-generation',tags:['code','license:mit'],siblings:[{rfilename:'model-Q4_K_M.gguf',size:110.97*1024**3}]}]);
 // Parser requires an exact integer byte count.
 models[0].files[0].bytes=Math.ceil(110.97*1024**3);
 const rows=rankOpenModels({models,checkedAt:'2026-09-15',version:'8',source:'test',stale:false},'coding','recommended',[],Date.now(),{scores:new Map(),memory});
 assert.equal(rows[0].compatibility,'insufficient');assert.equal(rows[0].memory,null);
});
