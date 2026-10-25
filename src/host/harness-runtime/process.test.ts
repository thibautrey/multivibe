import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { JsonPeer } from "./process.js";

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
