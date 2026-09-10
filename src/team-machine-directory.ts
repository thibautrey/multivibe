import {createHash,randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {Router} from 'express';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {verifyMachinePolicy,type SignedMachinePolicy} from './team-machine-protocol.js';
/** A signed, credential-free catalog. Every request still presents the member's own key. */
export class TeamMachineDirectory {
 private envelopes:SignedMachinePolicy[]=[];
 constructor(private filename:string,private trusted:Record<string,string>,private relayOrigin='https://app.multivibe.cloud'){}
 async initialize(){try{this.envelopes=JSON.parse(await fs.readFile(this.filename,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
 async apply(envelopes:SignedMachinePolicy[]){
  if(!Array.isArray(envelopes)||envelopes.length>1000)throw new Error('team_directory_invalid');
  for(const envelope of envelopes)verifyMachinePolicy(envelope,this.trusted);
  const previous=new Map(this.envelopes.map(e=>[e.policy.instanceId,e.policy]));
  for(const {policy:p} of envelopes){const old=previous.get(p.instanceId);if(old&&(p.revision<old.revision||p.issuedAt<old.issuedAt))throw new Error('team_directory_stale');}
  await fs.mkdir(path.dirname(this.filename),{recursive:true,mode:0o700});const tmp=this.filename+'.'+randomUUID()+'.tmp';await fs.writeFile(tmp,JSON.stringify(envelopes),{mode:0o600});await fs.rename(tmp,this.filename);this.envelopes=envelopes;
 }
 models(token:string){
  const digest=createHash('sha256').update(token).digest('hex');const models:Array<{id:string;object:'model';owned_by:'team';runtimeModel:string;instanceId:string;transport:string;endpoint:string}>=[];
  for(const envelope of this.envelopes){try{const p=verifyMachinePolicy(envelope,this.trusted);if(!p.enabled)continue;const member=p.keys.find(k=>k.digest===digest&&k.expiresAt>Date.now())?.memberId;if(!member)continue;
   for(const model of p.models){if(!model.members.includes(member))continue;models.push({id:'team/'+p.instanceId+'/'+encodeURIComponent(model.id),object:'model',owned_by:'team',runtimeModel:model.id,instanceId:p.instanceId,transport:p.transport,endpoint:p.transport==='private_network'?p.endpoint!:this.relayOrigin+'/client/v1/team-machines/'+p.instanceId});}
  }catch{}}
  return models;
 }
 router(){const router=Router();router.use(async(req,res,next)=>{
  const token=(req.headers.authorization??'').replace(/^Bearer /,'');
  const models=this.models(token);
  if(req.method==='GET'&&req.path==='/models'&&models.length){
   return res.json({object:'list',data:models.map(({id,object,owned_by})=>({id,object,owned_by}))});
  }
  if(req.method!=='POST'||typeof req.body?.model!=='string'||!req.body.model.startsWith('team/'))return next();
  const model=models.find(m=>m.id===req.body.model);if(!model)return res.status(403).json({error:'team_model_forbidden'});
  if(!['/responses','/chat/completions','/completions','/embeddings'].includes(req.path))return res.sendStatus(404);
  const controller=new AbortController();res.on('close',()=>controller.abort());
  try{const target=model.endpoint.replace(/\/$/,'')+'/v1'+req.path;const upstream=await fetch(target,{method:'POST',redirect:'error',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({...req.body,model:model.runtimeModel}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(300000)])});res.status(upstream.status);res.setHeader('content-type',upstream.headers.get('content-type')??'application/json');res.setHeader('cache-control','no-store');if(upstream.body)await pipeline(Readable.fromWeb(upstream.body as any),res);else res.end();}
  catch{if(!res.headersSent)res.status(503).json({error:'team_machine_unavailable'});else res.destroy();}
 });return router;}
}
