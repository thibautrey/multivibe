import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import http from 'node:http';
import {once} from 'node:events';
import {authorizeVoiceDevice,loopbackOrigin,InstanceVoiceBridge,SPEECH_MODELS} from './instance-voice.js';

test('voice companion observes pairing expiry, rotation grace and immediate file revocation',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'instance-voice-auth-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'state.json'),token='a'.repeat(43),previous='b'.repeat(43),deviceId=randomUUID();
  const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
  const state={version:1,machineId:randomUUID(),devices:[{id:deviceId,digest:digest(token),expiresAt:2000,previous:{digest:digest(previous),expiresAt:1500}}]};
  fs.writeFileSync(file,JSON.stringify(state));
  assert.equal(authorizeVoiceDevice(file,deviceId,token,1000).machineId,state.machineId);
  assert.doesNotThrow(()=>authorizeVoiceDevice(file,deviceId,previous,1000));
  assert.throws(()=>authorizeVoiceDevice(file,deviceId,previous,1500));
  assert.throws(()=>authorizeVoiceDevice(file,deviceId,token,2000));
  assert.throws(()=>authorizeVoiceDevice(file,randomUUID(),token,1000));
  state.devices=[];fs.writeFileSync(file,JSON.stringify(state));
  assert.throws(()=>authorizeVoiceDevice(file,deviceId,token,1000));
});

test('speech and voice edge destinations are loopback origins',()=>{
  assert.equal(loopbackOrigin('http://127.0.0.1:8000'),'http://127.0.0.1:8000');
  for(const value of ['http://0.0.0.0:8000','http://192.168.1.2:8000','https://example.org','http://user:pass@127.0.0.1','http://127.0.0.1/route','http://127.0.0.1/?token=secret'])assert.throws(()=>loopbackOrigin(value));
});

test('a refused native WebSocket handshake ends cleanly without recursive error dispatch',async t=>{
  const before=process.env.NODE_ENV;process.env.NODE_ENV='test';t.after(()=>{if(before===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=before;});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'instance-voice-reconnect-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'state.json');fs.writeFileSync(file,JSON.stringify({version:1,machineId:randomUUID(),machineToken:'mvr_'+'m'.repeat(43)}));
  const server=http.createServer((request,response)=>{
    response.setHeader('content-type','application/json');
    response.end(JSON.stringify(request.url==='/v1/models'?{data:[{id:SPEECH_MODELS.kokoro},{id:SPEECH_MODELS.stt}]}:{voices:['ff_siwis']}));
  });
  server.on('upgrade',(_request,socket)=>socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const address=server.address();assert(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port;
  const bridge=new InstanceVoiceBridge({stateFile:file,edgeOrigin:origin,edgeKey:'synthetic',speechOrigin:origin,llmModel:'selected',relayOrigin:origin});t.after(()=>bridge.stop());
  const handshake=once(server,'upgrade');const running=bridge.run();await handshake;
  await new Promise(r=>setTimeout(r,20));bridge.stop();await running;
});
