import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchCommunityUsage} from './community-model-usage.js';
const page={source:'anonymous-output-demand',generatedAt:'2026-09-14T00:00:00Z',window:{periodStart:'2026-08-15T00:00:00Z',periodEnd:'2026-09-14T00:00:00Z'},data:[{id:'hf:publisher/model',usagePopularity:{rank:1,source:'anonymous-output-demand'}}]};
test('joins exact HF identities and preserves dated ranks',async()=>{
 const result=await fetchCommunityUsage(async()=>new Response(JSON.stringify(page)));
 assert.equal(result.get('publisher/model')?.rank,1);
 assert.equal(result.get('publisher/model')?.periodEnd,page.window.periodEnd);
});
test('does not pass off legacy fallback as usage',async()=>{
 await assert.rejects(fetchCommunityUsage(async()=>new Response(JSON.stringify({...page,source:'catalog-fallback'}))));
});
test('empty usage is valid; unsafe or ambiguous identities are not joined',async()=>{
 assert.equal((await fetchCommunityUsage(async()=>new Response(JSON.stringify({...page,data:[]})))).size,0);
 const data=['openrouter:publisher/model','publisher/model','hf:../unsafe/path'].map(id=>({...page.data[0],id}));
 assert.equal((await fetchCommunityUsage(async()=>new Response(JSON.stringify({...page,data})))).size,0);
});
import {rankOpenModels} from './open-model-ranking.js';
import {parseOpenModels} from './open-model-catalog.js';
test('community ranking filters task evidence and does not establish compatibility',()=>{
 const models=parseOpenModels(['a','b','c'].map(name=>({id:`publisher/${name}`,private:false,gated:false,pipeline_tag:'text-generation',tags:['license:mit','conversational']})));
 models[0].communityUsage={rank:2,...page.window,checkedAt:page.generatedAt};
 models[1].communityUsage={rank:1,...page.window,checkedAt:page.generatedAt};
 const catalog={models,checkedAt:page.generatedAt,stale:false,source:'test',version:'2'};
 assert.deepEqual(rankOpenModels(catalog,'writing','community').map(r=>r.model.id),['publisher/b','publisher/a']);
 assert.equal(rankOpenModels(catalog,'writing','community')[0].compatibility,'unknown');
 assert.deepEqual(rankOpenModels(catalog,'coding','community'),[]);
});
