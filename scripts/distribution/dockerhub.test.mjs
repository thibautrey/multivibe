import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createContainerReleaseMetadata } from '../provider-host/provider-host-container-release.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const metadata = createContainerReleaseMetadata('ghcr.io/thibautrey/multivibe-host','1.2.3',`sha256:${'a'.repeat(64)}`,'b'.repeat(40));
async function exercise(scenario) {
  const dir = await mkdtemp(path.join(tmpdir(),'multivibe-registry-test-'));
  try {
    const bin = path.join(dir,'bin'); await mkdir(bin);
    await writeFile(path.join(dir,'metadata.json'),JSON.stringify(metadata));
    await writeFile(path.join(bin,'gh'),`#!/usr/bin/env node
const fs=require('fs'),path=require('path'),args=process.argv.slice(2);
if(args[0]==='attestation') process.exit(0);
if(args[1]==='download') fs.copyFileSync(process.env.MV_TEST_METADATA,path.join(args[args.indexOf('--dir')+1],'container-release.json'));
else process.stdout.write(process.env.MV_TEST_SCENARIO==='old'?'v2.0.0':'v1.2.3');
`,{mode:0o755});
    await writeFile(path.join(bin,'skopeo'),`#!/usr/bin/env node
const fs=require('fs'),args=process.argv.slice(2),scenario=process.env.MV_TEST_SCENARIO,digest='sha256:'+'a'.repeat(64);
fs.appendFileSync(process.env.MV_TEST_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='login') { process.stdin.resume(); }
else if(args[0]==='inspect') {
 if(args.includes('--format')) process.stdout.write(digest);
 else if(scenario==='conflict') process.stdout.write(JSON.stringify({Digest:'sha256:'+'f'.repeat(64)}));
 else if(scenario==='idempotent') process.stdout.write(JSON.stringify({Digest:digest}));
 else {process.stderr.write(scenario==='network'?'connection refused':'manifest unknown');process.exit(1);}
}
`,{mode:0o755});
    const exitCode = await new Promise((resolve,reject)=>{
      const child=spawn('bash',['scripts/distribution/publish-dockerhub.sh'],{cwd:root,stdio:['ignore','ignore','pipe'],env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,DOCKERHUB_NAMESPACE:'test-publisher',DOCKERHUB_USERNAME:'test-user',DOCKERHUB_TOKEN:'test-token',RELEASE_TAG:'v1.2.3',MV_TEST_METADATA:path.join(dir,'metadata.json'),MV_TEST_LOG:path.join(dir,'calls'),MV_TEST_SCENARIO:scenario}});
      child.stderr.resume(); child.on('error',reject); child.on('close',resolve);
    });
    const calls=(await readFile(path.join(dir,'calls'),'utf8')).trim().split('\n').map(JSON.parse);
    return {exitCode,copies:calls.filter(args=>args[0]==='copy')};
  } finally {await rm(dir,{recursive:true,force:true});}
}
test('registry publication fails closed on connection failures and version conflicts',async()=>{
  for(const scenario of ['network','conflict']) {
    const {exitCode,copies}=await exercise(scenario);
    assert.notEqual(exitCode,0);assert.deepEqual(copies,[]);
  }
});
test('registry publication preserves digests and never rolls latest back on replay',async()=>{
  const current=await exercise('new');assert.equal(current.exitCode,0);assert.equal(current.copies.length,2);
  for(const args of current.copies) assert.ok(args.includes('--preserve-digests'));
  const old=await exercise('old');assert.equal(old.exitCode,0);assert.equal(old.copies.length,1);
  assert.ok(old.copies[0].at(-1).endsWith(':1.2.3'));
  const same=await exercise('idempotent');assert.equal(same.exitCode,0);assert.equal(same.copies.length,1);
  assert.ok(same.copies[0].at(-1).endsWith(':latest'));
});
