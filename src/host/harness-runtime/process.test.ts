import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { JsonPeer, harnessEnvironment } from "./process.js";

test("native model credentials are inherited only by native-auth harnesses and Host credentials stay private",()=>{
  const keys=["ANTHROPIC_API_KEY","ADMIN_TOKEN","PROXY_API_KEY"] as const;
  const previous=keys.map(key=>process.env[key]);
  try{
    for(const key of keys)process.env[key]="private-environment-fixture";
    assert.equal(harnessEnvironment().ANTHROPIC_API_KEY,undefined);
    assert.equal(harnessEnvironment(true).ANTHROPIC_API_KEY,"private-environment-fixture");
    assert.equal(harnessEnvironment(true).ADMIN_TOKEN,undefined);assert.equal(harnessEnvironment(true).PROXY_API_KEY,undefined);
  }finally{keys.forEach((key,index)=>{if(previous[index]===undefined)delete process.env[key];else process.env[key]=previous[index];});}
});

test("JSONL transport preserves Unicode split across process output chunks",async t=>{
  const child=spawn(process.execPath,["-e",String.raw`
    process.stdin.once('data', input=>{
      const request=JSON.parse(input.toString());
      const value=Buffer.from(JSON.stringify({id:request.id,result:{text:'été 🌌'}})+'\n');
      const split=value.indexOf(Buffer.from('🌌'))+2;
      process.stdout.write(value.subarray(0,split));
      setTimeout(()=>process.stdout.write(value.subarray(split)),15);
    });
  `],{stdio:"pipe"});
  const peer=new JsonPeer(child,()=>{},async()=>({}),()=>{},()=>{});t.after(()=>peer.close());
  assert.deepEqual(await peer.request("unicode"),{text:"été 🌌"});
});

test("JSONL limit applies to individual records and rejects oversized incomplete records",async t=>{
  const child=spawn(process.execPath,["-e",String.raw`
    process.stdin.on('data',input=>{
      const request=JSON.parse(input.toString());
      if(request.method==='batch')process.stdout.write(Array.from({length:10},()=>JSON.stringify({notice:'small'})+'\n').join('')+JSON.stringify({id:request.id,result:'ok'})+'\n');
      else process.stdout.write('x'.repeat(200));
    });
  `],{stdio:"pipe"});
  let events=0;const peer=new JsonPeer(child,()=>{events++;},async()=>({}),()=>{},()=>{},true,128);t.after(()=>peer.close());
  assert.equal(await peer.request("batch"),"ok");assert.equal(events,10);
  await assert.rejects(peer.request("oversized"),/size limit/u);
});
