import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AccountStore } from './store.js';
import { isDiscoveredLocalRuntimeAccount, isConfiguredNvidiaPairAccount, authorizationForAccountRequest } from './local-runtime-discovery.js';
import { verifyMachinePolicy, type SignedMachinePolicy, type MachinePolicy } from './team-machine-protocol.js';

type Consent = { organizationId: string; instanceId: string; id: string };
type State = { consent: Consent | null; envelope: SignedMachinePolicy | null; stopped: boolean; lastClock: number };
export class TeamMachineSharing {
  private state: State = { consent: null, envelope: null, stopped: false, lastClock: 0 };
  private active = 0;
  private writes = Promise.resolve();
  constructor(private store: AccountStore, private filename: string, private trustedKeys: Record<string,string>, private clock = Date.now) {}
  async initialize() {
    try { this.state = JSON.parse(await fs.readFile(this.filename, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private async save() {
    const data = JSON.stringify(this.state);
    this.writes = this.writes.then(async () => {
      await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, data, { mode: 0o600 });
      await fs.rename(temporary, this.filename);
    });
    await this.writes;
  }
  private policy(): MachinePolicy | null {
    const now = this.clock();
    if (!this.state.consent || !this.state.envelope || this.state.stopped || now < this.state.lastClock) return null;
    try {
      const p = verifyMachinePolicy(this.state.envelope, this.trustedKeys, now);
      if (!p.enabled || p.consentId !== this.state.consent.id || p.organizationId !== this.state.consent.organizationId || p.instanceId !== this.state.consent.instanceId) return null;
      return p;
    } catch { return null; }
  }
  async consent(organizationId: string, instanceId: string) {
    const uuid = /^[0-9a-f-]{36}$/i;
    if (!uuid.test(organizationId) || !uuid.test(instanceId)) throw new Error('machine_identity_invalid');
    this.state = { consent: { organizationId, instanceId, id: randomUUID() }, envelope: null, stopped: false, lastClock: this.clock() };
    await this.save(); return this.state.consent;
  }
  async revokeConsent() { this.state.consent = null; this.state.envelope = null; this.state.stopped = true; await this.save(); }
  async stop() { this.state.stopped = true; await this.save(); }
  async inventory() {
    return (await this.store.listAccounts()).filter(a => a.enabled && (isDiscoveredLocalRuntimeAccount(a) || isConfiguredNvidiaPairAccount(a))).map(a => ({
      id: a.id, name: a.localRuntime!.adapter, models: a.localRuntime!.confirmedModelIds ?? [],
    }));
  }
  async apply(envelope: SignedMachinePolicy) {
    const p = verifyMachinePolicy(envelope, this.trustedKeys, this.clock());
    const consent = this.state.consent;
    if (!consent || p.consentId !== consent.id || p.organizationId !== consent.organizationId || p.instanceId !== consent.instanceId) throw new Error('machine_consent_required');
    const old = this.state.envelope?.policy;
    if (old && (p.revision < old.revision || p.issuedAt < old.issuedAt || (p.revision === old.revision && JSON.stringify({...p,keys:[],issuedAt:0,expiresAt:0,entitlementEndsAt:0}) !== JSON.stringify({...old,keys:[],issuedAt:0,expiresAt:0,entitlementEndsAt:0})))) throw new Error('machine_policy_stale');
    if (p.enabled) {
      const runtime = (await this.inventory()).find(r => r.id === p.runtimeId);
      if (!runtime || p.models.some(m => !runtime.models.includes(m.id))) throw new Error('machine_runtime_or_model_unavailable');
    }
    // A remote update never clears a local stop. A fresh local consent is required.
    this.state.envelope = envelope; this.state.lastClock = this.clock(); await this.save();
    return { revision: p.revision, status: this.state.stopped ? 'stopped' : 'applied' };
  }
  status() {
    const p = this.policy();
    return { consent: this.state.consent, state: this.state.stopped ? 'stopped' : p ? 'active' : this.state.envelope ? 'expired_or_disabled' : 'not_provisioned',
      sharing: p ? { name: 'Partage Team', runtimeId:p.runtimeId, transport:p.transport, models:p.models.map(m=>m.id), expiresAt:p.expiresAt, revision:p.revision } : null };
  }
  private authorize(secret: string, transport: string) {
    const p = this.policy(); if (!p || p.transport !== transport) throw new Error('machine_access_denied');
    const digest = createHash('sha256').update(secret).digest('hex');
    const member = p.keys.find(k => k.digest === digest)?.memberId;
    if (!member) throw new Error('machine_access_denied');
    return { policy:p, member };
  }
  async execute(secret:string,transport:'private_network'|'cloud_relay',requestPath:string,body:any,signal:AbortSignal) {
    const {policy:p,member}=this.authorize(secret,transport);
    if(!['/v1/chat/completions','/v1/responses','/v1/embeddings','/v1/completions'].includes(requestPath))throw new Error('machine_path_forbidden');
    if(!p.models.some(m=>m.id===body?.model&&m.members.includes(member)))throw new Error('machine_model_forbidden');
    if(this.active>=p.maxConcurrent)throw new Error('machine_capacity_exhausted');
    const account=(await this.store.listAccounts()).find(a=>a.id===p.runtimeId&&a.enabled);
    if(!account||(!isDiscoveredLocalRuntimeAccount(account)&&!isConfiguredNvidiaPairAccount(account)))throw new Error('machine_runtime_unavailable');
    const endpoint=new URL(account.localRuntime!.endpoint);
    if(!['127.0.0.1','[::1]'].includes(endpoint.hostname))throw new Error('machine_runtime_boundary');
    const target=new URL(requestPath,endpoint).href;
    const authorization=authorizationForAccountRequest(account,target);
    // Recheck after asynchronous account lookup before reserving the slot.
    if(this.active>=p.maxConcurrent)throw new Error('machine_capacity_exhausted');
    this.active++;
    try {
      const response=await fetch(target,{method:'POST',redirect:'error',headers:{'content-type':'application/json',...(authorization?{authorization}:{})},body:JSON.stringify(body),signal:AbortSignal.any([signal,AbortSignal.timeout(300000)])});
      let released=false;return {response,release:()=>{if(!released){released=true;this.active--;}}};
    }catch(error){this.active--;throw error;}
  }
  inferenceRouter() {
    const router = Router();
    router.use(async (req,res) => {
      const controller = new AbortController();

      try {
        // A reverse proxy must terminate TLS; Express trust proxy must be explicitly configured by the operator.
        if (!req.secure) return res.status(403).json({error:'machine_private_tls_required'});
        const {policy:p,member} = this.authorize((req.headers.authorization ?? '').replace(/^Bearer /,''),'private_network');
        const allowed = p.models.filter(m=>m.members.includes(member));
        if (req.method === 'GET' && req.path === '/v1/models') return res.json({object:'list',data:allowed.map(m=>({id:m.id,object:'model',owned_by:'team'}))});
        if (req.method !== 'POST' || !['/v1/chat/completions','/v1/responses','/v1/embeddings','/v1/completions'].includes(req.path)) return res.sendStatus(404);
        if (!allowed.some(m=>m.id===req.body?.model)) return res.status(403).json({error:'machine_model_forbidden'});
        const execution = await this.execute((req.headers.authorization ?? '').replace(/^Bearer /,''),'private_network',req.path,req.body,controller.signal);
        const upstream = execution.response;
        res.on('close',()=>controller.abort());
        res.once('close',execution.release);
        res.once('finish',execution.release);
        res.status(upstream.status);res.setHeader('content-type',upstream.headers.get('content-type') ?? 'application/json');res.setHeader('cache-control','no-store');
        if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as any),res);
        else res.end();
      } catch { if (!res.headersSent) res.status(403).json({error:'machine_sharing_unavailable'}); else res.destroy(); }

    }); return router;
  }
  adminRouter() {
    const router = Router();
    router.get('/',(_req,res)=>res.json(this.status()));
    router.get('/runtimes',async(_req,res)=>res.json({runtimes:await this.inventory()}));
    router.post('/consent',async(req,res)=>{try {
      if(req.body?.authorizeRemoteManagement!==true) return res.status(400).json({error:'explicit_consent_required'});
      return res.json(await this.consent(req.body.organizationId,req.body.instanceId));
    }catch{return res.status(400).json({error:'invalid_machine_consent'});}});
    router.delete('/consent',async(_req,res)=>{await this.revokeConsent();res.sendStatus(204);});
    router.post('/stop',async(_req,res)=>{await this.stop();res.sendStatus(204);});
    router.post('/policy',async(req,res)=>{try {res.json(await this.apply(req.body));}catch {res.status(409).json({error:'machine_policy_rejected'});}});
    return router;
  }
}
