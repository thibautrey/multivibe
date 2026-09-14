import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type {AddressInfo} from 'node:net';
import type {LocalModelPreparation} from '../../local-model-preparation.js';
import {localPreparationRoutes} from './local-preparation.js';
async function fixture(t:any, service?:Partial<LocalModelPreparation>) {
 const app=express();app.use(express.json());app.use('/prepare',localPreparationRoutes(service as LocalModelPreparation));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 t.after(()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())));
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/prepare`;
 return (path='',body?:unknown)=>fetch(base+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
}
test('unconfigured runtime cannot expose a working preparation endpoint',async t=>{
 const request=await fixture(t);const r=await request();assert.equal(r.status,503);assert.equal(r.headers.get('cache-control'),'no-store');assert.deepEqual(await r.json(),{error:'local_preparation_unavailable'});
});
test('quote accepts identity only and cannot initiate a client-selected artifact or policy',async t=>{
 const models:string[]=[];const request=await fixture(t,{quote:async(id:string)=>{models.push(id);return {id:'job'} as any;}});
 for(const body of [{modelId:'a',url:'http://elsewhere'},{modelId:'a',policyRevision:2},{modelId:''},[],null,{modelId:'a\n'}]) assert.equal((await request('/quote',body)).status,400);
 assert.equal((await request('/quote',{modelId:'publisher/model'})).status,201);assert.deepEqual(models,['publisher/model']);
});
test('consent uses only exact stored digest; cancellation accepts no policy changes',async t=>{
 const calls:unknown[]=[];const request=await fixture(t,{consent:async(id,digest)=>{calls.push([id,digest]);return {id} as any;},cancel:async id=>{calls.push(id);}});
 assert.equal((await request('/job/consent',{consentDigest:'wrong'})).status,400);
 const digest='a'.repeat(64);assert.equal((await request('/job/consent',{consentDigest:digest})).status,202);
 assert.equal((await request('/job/cancel',{paused:false})).status,400);assert.equal((await request('/job/cancel',{})).status,204);
 assert.deepEqual(calls,[['job',digest],'job']);
});
test('errors are allowlisted and never disclose driver exception text',async t=>{
 let code='Bearer a-secret';const request=await fixture(t,{list:async()=>{throw Error(code);}});
 let r=await request();assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:'local_preparation_failed'});
 code='host_preparation_busy';r=await request();assert.equal(r.status,409);assert.deepEqual(await r.json(),{error:code});
});
