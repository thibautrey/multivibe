import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type PreparationStage = 'awaiting-consent' | 'installing' | 'downloading' | 'preparing' | 'testing' | 'verifying-chat' | 'ready' | 'cancelled' | 'interrupted' | 'failed';
export type PreparationQuote = {
  hostId: string; hostName: string; modelId: string; variant: string;
  runtime: string; runtimeVersion: string; policyRevision: number;
  artifactDigest: string; downloadBytes: number; requiredDiskBytes: number;
  availableDiskBytes: number; reserveDiskBytes: number;
  compatibility: 'estimated-fit'; configurationKey: string;
};
export type PreparationJob = {
  id: string; quote: PreparationQuote; consentDigest: string; stage: PreparationStage;
  createdAt: string; updatedAt: string; consentedAt?: string;
  progress?: { completedBytes: number; totalBytes: number };
  error?: string; chatModelId?: string; testedAt?: string;
};
/** All implementation-side credentials and runtime handles stay behind this interface.
 * Implementations must preserve external runtimes and existing policy/download limits.
 * A quote is metadata-only; none of its methods may silently route to Cloud.
 */
export interface LocalPreparationDriver {
  preflight(modelId: string): Promise<PreparationQuote>;
  validate(quote: PreparationQuote): Promise<void>;
  install(quote: PreparationQuote, signal: AbortSignal): Promise<void>;
  download(quote: PreparationQuote, signal: AbortSignal, progress: (completedBytes: number, totalBytes: number) => Promise<void>): Promise<void>;
  prepare(quote: PreparationQuote, signal: AbortSignal): Promise<void>;
  test(quote: PreparationQuote, signal: AbortSignal): Promise<{ local: true; output: string }>;
  verifyChat(quote: PreparationQuote, signal: AbortSignal): Promise<{ local: true; modelId: string; configurationKey: string }>;
}
const active = new Set<PreparationStage>(['installing','downloading','preparing','testing','verifying-chat']);
const digest = (quote: PreparationQuote) => createHash('sha256').update(JSON.stringify(quote)).digest('hex');
const copy = <T>(value:T):T => structuredClone(value);
function validateQuote(q: PreparationQuote) {
  if (!q || ['hostId','hostName','modelId','variant','runtime','runtimeVersion','artifactDigest','configurationKey'].some(key => typeof q[key as keyof PreparationQuote] !== 'string' || !q[key as keyof PreparationQuote])) throw Error('invalid_preflight');
  if (q.compatibility !== 'estimated-fit' || !Number.isSafeInteger(q.policyRevision) || q.policyRevision < 1) throw Error('compatibility_not_established');
  for (const n of [q.downloadBytes,q.requiredDiskBytes,q.availableDiskBytes,q.reserveDiskBytes]) if (!Number.isSafeInteger(n) || n < 0) throw Error('resources_unknown');
  if (q.requiredDiskBytes > q.availableDiskBytes - q.reserveDiskBytes) throw Error('insufficient_disk');
}
/** One store per Host, backed by the existing runtime driver, not another runtime manager.
 * Browser reloads retain progress. Process restart interrupts work explicitly: a driver
 * must opt into resumption separately; this coordinator never promises byte resumption.
 */
export class LocalModelPreparation {
  private jobs = new Map<string, PreparationJob>();
  private initialized?: Promise<void>;
  private serial: Promise<unknown> = Promise.resolve();
  private running = new Map<string, {abort: AbortController; done: Promise<void>}>();
  constructor(private file: string, private driver: LocalPreparationDriver, private now = () => new Date().toISOString()) {}
  private exclusive<T>(fn:()=>Promise<T>):Promise<T> {
    const next=this.serial.then(fn,fn); this.serial=next.catch(()=>{}); return next;
  }
  private async persist() {
    await fs.mkdir(path.dirname(this.file),{recursive:true});
    const temporary=`${this.file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary,JSON.stringify({version:1,jobs:[...this.jobs.values()]}),{mode:0o600,flag:'wx'}); await fs.rename(temporary,this.file); }
    finally { await fs.rm(temporary,{force:true}); }
  }
  async initialize() {
    this.initialized ??= this.exclusive(async()=>{
      let raw;
      try { raw=JSON.parse(await fs.readFile(this.file,'utf8')); }
      catch(error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return; throw Error('preparation_store_unavailable'); }
      if (raw.version!==1 || !Array.isArray(raw.jobs)) throw Error('invalid_preparation_store');
      for(const job of raw.jobs as PreparationJob[]) {
        validateQuote(job.quote);
        if(typeof job.id!=='string' || job.consentDigest!==digest(job.quote)) throw Error('invalid_preparation_store');
        // Ready is not durable proof of a route after a runtime restart.
        if(active.has(job.stage) || job.stage==='ready') {
          job.stage='interrupted';job.error='host_restarted_recheck_required';delete job.chatModelId;
          job.updatedAt=this.now();
        }
        this.jobs.set(job.id,job);
      }
      await this.persist();
    });
    await this.initialized;
  }
  async list() { await this.initialize(); await this.serial; return copy([...this.jobs.values()]); }
  async quote(modelId:string) {
    await this.initialize();
    return this.exclusive(async()=>{
      const quote=await this.driver.preflight(modelId);validateQuote(quote);
      if(quote.modelId!==modelId) throw Error('model_identity_mismatch');
      const hash=digest(quote);
      const existing=[...this.jobs.values()].find(j=>j.consentDigest===hash && (j.stage==='awaiting-consent'||active.has(j.stage)));
      if(existing) return copy(existing);
      const job:PreparationJob={id:randomUUID(),quote:copy(quote),consentDigest:hash,stage:'awaiting-consent',createdAt:this.now(),updatedAt:this.now()};
      this.jobs.set(job.id,job);await this.persist();return copy(job);
    });
  }
  async consent(id:string, consentDigest:string) {
    await this.initialize();
    return this.exclusive(async()=>{
      const job=this.jobs.get(id);if(!job || job.consentDigest!==consentDigest) throw Error('consent_mismatch');
      if(this.running.has(id)) return copy(job);
      if(job.stage!=='awaiting-consent') throw Error('new_preflight_required');
      if(this.running.size) throw Error('host_preparation_busy');
      await this.driver.validate(copy(job.quote));
      job.consentedAt=this.now();job.stage='installing';job.updatedAt=this.now();await this.persist();
      const abort=new AbortController();
      // Defer execution until this transaction releases its persistence lock.
      const done=Promise.resolve().then(()=>this.execute(id,abort.signal)).finally(()=>this.running.delete(id));
      this.running.set(id,{abort,done});return copy(job);
    });
  }
  async cancel(id:string) {
    await this.initialize();
    await this.exclusive(async()=>{
      const job=this.jobs.get(id);if(!job) throw Error('preparation_not_found');
      if(job.stage==='ready') throw Error('preparation_already_ready');
      this.running.get(id)?.abort.abort();job.stage='cancelled';job.updatedAt=this.now();delete job.chatModelId;
      await this.persist();
    });
  }
  async wait(id:string) { await this.running.get(id)?.done; }
  private async execute(id:string,signal:AbortSignal) {
    const job=this.jobs.get(id)!;
    const checkpoint=async(stage:PreparationStage)=>{
      signal.throwIfAborted();await this.driver.validate(copy(job.quote));signal.throwIfAborted();
      await this.exclusive(async()=>{signal.throwIfAborted();job.stage=stage;job.updatedAt=this.now();await this.persist();});
    };
    try {
      await checkpoint('installing');await this.driver.install(copy(job.quote),signal);
      await checkpoint('downloading');await this.driver.download(copy(job.quote),signal,async(completedBytes,totalBytes)=>{
        await this.exclusive(async()=>{
          signal.throwIfAborted();
          if(!Number.isSafeInteger(completedBytes)||!Number.isSafeInteger(totalBytes)||completedBytes<0||totalBytes<completedBytes||totalBytes>job.quote.downloadBytes) throw Error('download_exceeds_consent');
          if(job.progress && completedBytes<job.progress.completedBytes) throw Error('invalid_download_progress');
          job.progress={completedBytes,totalBytes};job.updatedAt=this.now();await this.persist();
        });
      });
      await checkpoint('preparing');await this.driver.prepare(copy(job.quote),signal);
      await checkpoint('testing');const test=await this.driver.test(copy(job.quote),signal);
      if(test.local!==true||!test.output?.trim()) throw Error('local_test_failed');
      await checkpoint('verifying-chat');const route=await this.driver.verifyChat(copy(job.quote),signal);
      if(route.local!==true||!route.modelId||route.configurationKey!==job.quote.configurationKey) throw Error('chat_route_not_ready');
      await this.driver.validate(copy(job.quote));
      await this.exclusive(async()=>{signal.throwIfAborted();job.stage='ready';job.chatModelId=route.modelId;job.testedAt=this.now();job.updatedAt=this.now();await this.persist();});
    }catch(error) {
      await this.exclusive(async()=>{
        job.stage=signal.aborted?'cancelled':'failed';
        // Do not persist arbitrary driver exception text: it can contain credentials.
        const code=error instanceof Error?error.message:'';
        job.error=signal.aborted?'cancelled':new Set(['download_exceeds_consent','invalid_download_progress','local_test_failed','chat_route_not_ready']).has(code)?code:'preparation_failed';
        delete job.chatModelId;job.updatedAt=this.now();await this.persist();
      });
    }
  }
}
