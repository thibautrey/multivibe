import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {renderInstanceVoicePlist,stageInstanceVoiceCompanion,INSTANCE_VOICE_LABEL} from './install-instance-voice-companion.mjs';

test('voice companion launch contract is separate, persistent and contains no credentials',()=>{
  const plist=renderInstanceVoicePlist({node:'/Applications/Host & Voice/node',main:'/private/runtime/main.js',dataDir:'/private/data',stdout:'/private/out',stderr:'/private/err'});
  assert.match(plist,new RegExp(INSTANCE_VOICE_LABEL));assert.match(plist,/<key>KeepAlive<\/key><true\/>/);
  assert.match(plist,/Host &amp; Voice/);assert.doesNotMatch(plist,/mvr_|deviceToken|proxy_api_key|accessToken/);
  assert.doesNotMatch(plist,/MultiVibe Host.app<\/string><key>KeepAlive/);
});

test('staging copies only the reviewed runtime files with private modes',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'instance-voice-stage-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),home=path.join(root,'home'),node=path.join(root,'node');fs.mkdirSync(source);fs.writeFileSync(node,'runtime');
  for(const name of ['instance-voice-main.js','instance-voice.js','instance-voice-audio.js'])fs.writeFileSync(path.join(source,name),'// '+name);
  const result=stageInstanceVoiceCompanion({repository:root,home,dataDir:path.join(home,'data'),source,node});
  assert.deepEqual(fs.readdirSync(path.dirname(result.main)).sort(),['instance-voice-audio.js','instance-voice-main.js','instance-voice.js']);
  assert.equal(fs.statSync(result.main).mode&0o777,0o600);assert.equal(fs.statSync(result.plist).mode&0o777,0o600);
});
