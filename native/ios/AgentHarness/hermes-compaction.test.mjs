import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareCompaction,compactionView,thresholdTokens} from './hermes-compaction.mjs';
import {runHermesTurn} from './hermes-loop.mjs';
const canonical=[{role:'system',content:'policy'},{role:'user',content:'old request'},{role:'assistant',content:'',tool_calls:[{id:'a',function:{name:'read',arguments:'{}'}}]},{role:'tool',tool_call_id:'a',content:'evidence'},{role:'assistant',content:'finished'},{role:'user',content:'current request'}];
function fixture(){let summaries=0;const checkpoints=[];return {checkpoints,get summaries(){return summaries;},measure:async(messages,tools,reserve)=>({promptTokens:messages[0]?.content?.startsWith('Summarize')?1000:messages.some(m=>m.content?.startsWith('[CONTEXT COMPACTION'))?600:2800,contextTokens:4096,reservedOutputTokens:reserve}),summarize:async()=>{summaries++;return {content:'Completed old request with evidence.',finish_reason:'stop'};},checkpoint:async(messages,state)=>checkpoints.push(structuredClone({messages,state})),model:async()=>({content:'Answer',finish_reason:'stop'}),execute:async()=>{throw Error('must not replay');}};}
test('threshold reserves output and applies pinned upstream small-window floor cap',()=>{assert.equal(thresholdTokens(4096,1024),2611);assert.equal(thresholdTokens(128000,8192),64000);assert.equal(thresholdTokens(4096,1024,1),2611);});
test('compact view preserves canonical history and entire tool batch in summarized prefix',async()=>{const host=fixture(),before=structuredClone(canonical);const result=await prepareCompaction(canonical,[],undefined,host);assert.deepEqual(canonical,before);assert.equal(result.state.coveredCount,5);assert.equal(result.state.prefixJSON,JSON.stringify(canonical.slice(0,5)));assert.deepEqual(result.messages.at(-1),canonical.at(-1));assert.equal(result.messages[0].content,'policy');assert.equal(host.summaries,1);const repeat=await prepareCompaction(canonical,[],result.state,host);assert.deepEqual(repeat,result);assert.equal(host.summaries,1);});
test('oversized pending tool batch, current-only exchange and altered prefix refuse compaction',async()=>{const host=fixture();host.measure=async(m,t,r)=>({promptTokens:m[0]?.content?.startsWith('Summarize')?1000:m.some(x=>x.content?.startsWith('[CONTEXT COMPACTION'))?600:3500,contextTokens:4096,reservedOutputTokens:r});await assert.rejects(prepareCompaction(canonical.slice(0,4),[],undefined,host),/cannot be compacted/);await assert.rejects(prepareCompaction(canonical.slice(0,2),[],undefined,host),/cannot be compacted/);const result=await prepareCompaction(canonical,[],undefined,host);assert.throws(()=>compactionView([{...canonical[0],content:'different'},...canonical.slice(1)],result.state),/Invalid compaction/);});
test('summary refusal/truncation/tool use/oversize input fail without mutating transcript',async()=>{for(const reply of [{content:'partial',finish_reason:'length'},{content:'',finish_reason:'stop'},{content:'I cannot summarize this',finish_reason:'stop'},{content:'text',finish_reason:'stop',tool_calls:[{}]}]){const host=fixture();host.summarize=async()=>reply;await assert.rejects(prepareCompaction(canonical,[],undefined,host),/Incomplete or refused/);}const host=fixture();host.measure=async(m,t,r)=>({promptTokens:5000,contextTokens:4096,reservedOutputTokens:r});await assert.rejects(prepareCompaction(canonical,[],undefined,host),/completed exchange exceeds/);});
test('failed compaction checkpoint blocks next model and preserves previous durable transcript',async()=>{const host=fixture();let calls=0;host.model=async()=>{calls++;return {content:'wrong'};};host.checkpoint=async(m,s)=>{assert.deepEqual(m,canonical);if(s.compaction)throw Error('disk full');};await assert.rejects(runHermesTurn({messages:canonical,compaction:true},host),/disk full/);assert.equal(calls,0);});
test('resume reuses compacted inference view while final transcript stays lossless and tools never replay',async()=>{const host=fixture(),prepared=await prepareCompaction(canonical,[],undefined,host);let received;host.model=async m=>{received=m;return {content:'Answer',finish_reason:'stop'};};const result=await runHermesTurn({compaction:true,resume:{messages:canonical,state:{compaction:prepared.state}}},host);assert.deepEqual(received,prepared.messages);assert.deepEqual(result.messages.slice(0,-1),canonical);assert.equal(host.summaries,1);assert.ok(host.checkpoints.every(c=>c.messages[2].tool_calls[0].id==='a'));});
test('cancellation after summary rejects without publishing state',async()=>{const host=fixture(),controller=new AbortController();host.signal=controller.signal;host.summarize=async()=>{controller.abort();return {content:'summary',finish_reason:'stop'};};await assert.rejects(prepareCompaction(canonical,[],undefined,host),/cancelled/);assert.equal(host.checkpoints.length,0);});
test('threshold exactly matches executed pinned upstream extracted helpers',async()=>{
 const {execFileSync}=await import('node:child_process');
 const cases=[[4096,1024,.5],[8192,1024,.5],[64000,4096,.5],[128000,8192,.5],[1000000,8192,.5],[4096,1024,1],[4096,1024,.9]];
 const script='import runpy,json,sys\nc=runpy.run_path(sys.argv[1])["ContextCompressor"]\nprint(json.dumps([c._compute_threshold_tokens(ctx,pct,reserve) for ctx,reserve,pct in json.loads(sys.argv[2])]))';
 const path=fileURLToPath(new URL('./compaction-threshold-upstream.py',import.meta.url));
 assert.deepEqual(cases.map(([ctx,reserve,pct])=>thresholdTokens(ctx,reserve,pct)),JSON.parse(execFileSync('python3',['-c',script,path,JSON.stringify(cases)],{encoding:'utf8'})));
});
test('new summary must actually shrink the measured model context',async()=>{const host=fixture();host.measure=async(m,t,r)=>({promptTokens:m[0]?.content?.startsWith('Summarize')?1000:2800,contextTokens:4096,reservedOutputTokens:r});await assert.rejects(prepareCompaction(canonical,[],undefined,host),/did not produce/);});

test('high but fitting active exchange passes intact without a summary',async()=>{const host=fixture(),messages=canonical.slice(0,2);const result=await prepareCompaction(messages,[],undefined,host);assert.deepEqual(result,{messages,state:undefined});assert.equal(host.summaries,0);});
test('reused summary with no new complete exchange passes when high but still fitting',async()=>{const host=fixture(),first=await prepareCompaction(canonical,[],undefined,host);host.measure=async(m,t,r)=>({promptTokens:2800,contextTokens:4096,reservedOutputTokens:r});const result=await prepareCompaction(canonical,[],first.state,host);assert.deepEqual(result,first);assert.equal(host.summaries,1);});
test('oversized summary input defers compaction only when existing view fits hard budget',async()=>{const host=fixture();host.measure=async(m,t,r)=>({promptTokens:m[0]?.content?.startsWith('Summarize')?5000:2800,contextTokens:4096,reservedOutputTokens:r});const result=await prepareCompaction(canonical,[],undefined,host);assert.deepEqual(result,{messages:canonical,state:undefined});assert.equal(host.summaries,0);});

function longTranscript(exchanges = 9, width = 1200) {
  const messages = [{role:'system',content:'Keep the canonical transcript.'}];
  for(let i=0;i<exchanges;i++) messages.push(
    {role:'user',content:`Exchange ${i}: `+'x'.repeat(width)},
    {role:'assistant',content:'',tool_calls:[{id:`chunk-${i}`,type:'function',function:{name:'read',arguments:JSON.stringify({index:i})}}]},
    {role:'tool',tool_call_id:`chunk-${i}`,content:`Evidence ${i}`},
    {role:'assistant',content:`Completed ${i}`});
  messages.push({role:'user',content:'Latest user request must stay literal.'});
  return messages;
}
function chunkHost({failAt, cancelAt, controller} = {}) {
  const measured = [], summarized = [];
  const tokens = messages => JSON.stringify(messages).length;
  return {
    measured,summarized,tokens,signal:controller?.signal,
    measure:async(messages,tools,reserve)=>{
      measured.push({messages:structuredClone(messages),tools:structuredClone(tools),reserve});
      return {promptTokens:tokens(messages),contextTokens:4096,reservedOutputTokens:reserve};
    },
    summarize:async(messages,reserve)=>{
      assert.ok(tokens(messages)+reserve<=4096,'every summary has an exact successful preflight');
      assert.ok(measured.some(m=>m.reserve===reserve&&m.tools.length===0&&JSON.stringify(m.messages)===JSON.stringify(messages)));
      const payload=JSON.parse(messages.at(-1).content);
      const pending=new Set();
      for(const message of payload.completedExchanges){
        for(const call of message.tool_calls??[])pending.add(call.id);
        if(message.role==='tool')assert.ok(pending.delete(message.tool_call_id),'tool result stays with its call');
      }
      assert.equal(pending.size,0,'no chunk splits an atomic tool group');
      summarized.push({payload,reserve});
      if(cancelAt===summarized.length)controller.abort();
      if(failAt===summarized.length)return {content:'I cannot summarize this',finish_reason:'stop'};
      return {content:`Rolling summary ${summarized.length}`,finish_reason:'stop'};
    },
    execute:async()=>assert.fail('compaction must never execute tools')
  };
}
test('multi-pass compaction measures and summarizes complete exchanges while retaining full canonical history',async()=>{
  const messages=longTranscript(),before=structuredClone(messages),host=chunkHost();
  const result=await prepareCompaction(messages,[{name:'read'}],undefined,host);
  assert.ok(host.summarized.length>=3);assert.equal(result.state.coveredCount,messages.length-1);
  assert.equal(result.state.prefixJSON,JSON.stringify(messages.slice(0,-1)));assert.deepEqual(messages,before);
  assert.deepEqual(result.messages.at(-1),messages.at(-1));assert.ok(host.tokens(result.messages)+1024<=4096);
  assert.deepEqual(host.summarized.flatMap(s=>s.payload.completedExchanges),messages.slice(1,-1));
  assert.equal(host.summarized[0].payload.previousSummary,null);
  for(let i=1;i<host.summarized.length;i++)assert.equal(host.summarized[i].payload.previousSummary,`Rolling summary ${i}`);
});
test('second-chunk refusal and cancellation publish no state and preserve prior compaction',async()=>{
  const messages=longTranscript(),before=structuredClone(messages);
  const previous={version:1,coveredCount:5,prefixJSON:JSON.stringify(messages.slice(0,5)),summary:'Existing saved summary'};
  const original=structuredClone(previous);
  for(const mode of ['refusal','cancel']){
    const controller=new AbortController(),host=chunkHost(mode==='refusal'?{failAt:2}:{cancelAt:2,controller});
    await assert.rejects(prepareCompaction(messages,[],previous,host),mode==='refusal'?/refused/:/cancelled/);
    assert.equal(host.summarized.length,2);assert.deepEqual(previous,original);assert.deepEqual(messages,before);
  }
});
test('previous summary is carried through newly summarized suffix chunks without revisiting old exchanges',async()=>{
  const messages=longTranscript(),previous={version:1,coveredCount:9,prefixJSON:JSON.stringify(messages.slice(0,9)),summary:'Previous durable summary'},host=chunkHost();
  const result=await prepareCompaction(messages,[],previous,host);
  assert.ok(host.summarized.length>=3);assert.equal(host.summarized[0].payload.previousSummary,previous.summary);
  assert.deepEqual(host.summarized.flatMap(s=>s.payload.completedExchanges),messages.slice(9,-1));
  assert.equal(result.state.coveredCount,messages.length-1);assert.deepEqual(result.messages.at(-1),messages.at(-1));
});
test('multi-pass compaction has a strict 32-summary cap and leaves canonical transcript intact',async()=>{
  const messages=longTranscript(70,1800),before=structuredClone(messages),host=chunkHost();
  await assert.rejects(prepareCompaction(messages,[],undefined,host),/limit|budget|many|32/i);
  assert.equal(host.summarized.length,32);assert.deepEqual(messages,before);
});
test('indivisible oversized tool exchange fails explicitly without executing or dropping it',async()=>{
  const messages=longTranscript(2,5000),before=structuredClone(messages),host=chunkHost();
  await assert.rejects(prepareCompaction(messages,[],undefined,host),/budget|exceed|fit|large/i);
  assert.equal(host.summarized.length,0);assert.deepEqual(messages,before);
});
