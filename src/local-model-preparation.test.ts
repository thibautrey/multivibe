import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalModelPreparation, type LocalPreparationDriver, type PreparationQuote } from './local-model-preparation.js';
const quote:PreparationQuote={hostId:'machine',hostName:'This Host',modelId:'publisher/model',variant:'q4',runtime:'existing-manager',runtimeVersion:'1',policyRevision:1,artifactDigest:'sha256:pinned',downloadBytes:100,requiredDiskBytes:150,availableDiskBytes:300,reserveDiskBytes:100,compatibility:'estimated-fit',configurationKey:'machine/model/q4/runtime1'};
async function fixture(t:any, overrides:Partial<LocalPreparationDriver>={}) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mv-prepare-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const calls:string[]=[];
 const driver:LocalPreparationDriver={preflight:async()=>({...quote}),validate:async()=>{},install:async()=>{calls.push('install');},download:async(_q,_s,progress)=>{calls.push('download');await progress(50,100);await progress(100,100);},prepare:async()=>{calls.push('prepare');},test:async()=>{calls.push('test');return {local:true,output:'OK'};},verifyChat:async()=>{calls.push('chat');return {local:true,modelId:'local-route',configurationKey:quote.configurationKey};},...overrides};
 const file=path.join(dir,'jobs.json');return {service:new LocalModelPreparation(file,driver),file,driver,calls};
}
test('no work before exact consent; double click starts one pipeline; ready requires both tests',async t=>{
 const {service,calls}=await fixture(t);const job=await service.quote(quote.modelId);assert.deepEqual(calls,[]);
 assert.equal((await service.quote(quote.modelId)).id,job.id);
 await assert.rejects(service.consent(job.id,'wrong'),/consent_mismatch/);assert.deepEqual(calls,[]);
 await Promise.all([service.consent(job.id,job.consentDigest),service.consent(job.id,job.consentDigest)]);await service.wait(job.id);
 assert.deepEqual(calls,['install','download','prepare','test','chat']);assert.equal((await service.list())[0].stage,'ready');
});
test('unknown resources and insufficient disk cannot request consent',async t=>{
 for(const change of [{availableDiskBytes:200},{availableDiskBytes:NaN},{compatibility:'unknown'}]) {
  const {service,calls}=await fixture(t,{preflight:async()=>({...quote,...change}) as PreparationQuote});await assert.rejects(service.quote(quote.modelId));assert.deepEqual(calls,[]);
 }
});
test('failed local response or wrong chat configuration never becomes ready',async t=>{
 for(const overrides of [{test:async()=>({local:true as const,output:''})},{verifyChat:async()=>({local:true as const,modelId:'route',configurationKey:'different'})}]) {
 const {service}=await fixture(t,overrides);const job=await service.quote(quote.modelId);await service.consent(job.id,job.consentDigest);await service.wait(job.id);assert.equal((await service.list())[0].stage,'failed');assert.equal((await service.list())[0].chatModelId,undefined);
 }
});
test('cancel during download cannot run prepare or declare ready even if driver ignores abort',async t=>{
 let release!:()=>void;let entered!:()=>void;const start=new Promise<void>(r=>entered=r);const blocked=new Promise<void>(r=>release=r);
 const {service,calls}=await fixture(t,{download:async()=>{entered();await blocked;}});const job=await service.quote(quote.modelId);await service.consent(job.id,job.consentDigest);await start;await service.cancel(job.id);release();await service.wait(job.id);assert.equal((await service.list())[0].stage,'cancelled');assert.deepEqual(calls,['install']);
});
test('restart retains consent and progress but never retries downloads or trusts old ready state',async t=>{
 const {service,file,driver,calls}=await fixture(t);const job=await service.quote(quote.modelId);await service.consent(job.id,job.consentDigest);await service.wait(job.id);
 const restarted=new LocalModelPreparation(file,driver);assert.equal((await restarted.list())[0].stage,'interrupted');assert.equal((await restarted.list())[0].progress?.completedBytes,100);assert.equal(calls.length,5);await assert.rejects(restarted.consent(job.id,job.consentDigest),/new_preflight_required/);
});
test('changed artifact requires new consent; policy failure stops before install',async t=>{
 let changed=false;const {service,calls}=await fixture(t,{preflight:async()=>({...quote,artifactDigest:changed?'new':'old'}),validate:async()=>{throw Error('secret must not escape');}});
 const first=await service.quote(quote.modelId);changed=true;const second=await service.quote(quote.modelId);assert.notEqual(first.consentDigest,second.consentDigest);await assert.rejects(service.consent(second.id,first.consentDigest),/consent_mismatch/);await assert.rejects(service.consent(second.id,second.consentDigest));assert.deepEqual(calls,[]);
});
test('download cannot exceed approved volume and runtime errors are redacted',async t=>{
 for(const download of [async(_q:any,_s:any,p:any)=>p(101,101),async()=>{throw Error('Bearer secret');}]) {
 const {service,file}=await fixture(t,{download});const job=await service.quote(quote.modelId);await service.consent(job.id,job.consentDigest);await service.wait(job.id);assert.equal((await service.list())[0].stage,'failed');assert.equal((await fs.readFile(file,'utf8')).includes('Bearer secret'),false);
 }
});

test('actionable Host failures survive persistence without exposing raw errors',async t=>{
 for(const code of ['host_permission_required','runtime_download_quote_required','import_reconciliation_required','new_preflight_required','insufficient_disk','resources_unknown','local_preparation_unavailable']) {
  const {service}=await fixture(t,{install:async()=>{throw Error(code);}});
  const job=await service.quote(quote.modelId);
  await service.consent(job.id,job.consentDigest);await service.wait(job.id);
  const stopped=(await service.list())[0];
  assert.equal(stopped.stage,'failed');assert.equal(stopped.error,code);assert.equal(stopped.chatModelId,undefined);
 }
});
