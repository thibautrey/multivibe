import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { fail, HarnessRuntimeError, redact, type AdapterContext } from "./types.js";

export function harnessEnvironment(nativeCredentials=false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv={NO_COLOR:"1",TERM:"dumb"};
  for(const key of ["HOME","USER","LOGNAME","PATH","TMPDIR","LANG","LC_ALL","SHELL","XDG_CONFIG_HOME","XDG_DATA_HOME","XDG_STATE_HOME","SSH_AUTH_SOCK","SSL_CERT_FILE","NODE_EXTRA_CA_CERTS","CODEX_HOME","CLAUDE_CONFIG_DIR","PI_CODING_AGENT_DIR","HERMES_HOME","GEMINI_CLI_HOME","OPENCODE_CONFIG_DIR"])
    if(process.env[key]) env[key]=process.env[key];
  for(const key of ["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY","http_proxy","https_proxy","all_proxy","no_proxy"])if(process.env[key])env[key]=process.env[key];
  if(nativeCredentials)for(const key of ["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_BASE_URL","CLAUDE_CODE_OAUTH_TOKEN","OPENAI_API_KEY","OPENAI_BASE_URL","OPENAI_ORG_ID","OPENAI_PROJECT_ID","CODEX_API_KEY","GOOGLE_API_KEY","GEMINI_API_KEY","GOOGLE_GENAI_USE_VERTEXAI","GOOGLE_APPLICATION_CREDENTIALS","GOOGLE_CLOUD_PROJECT","GOOGLE_CLOUD_LOCATION","AWS_PROFILE","AWS_REGION","AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_SESSION_TOKEN","AZURE_OPENAI_API_KEY","AZURE_OPENAI_ENDPOINT","MISTRAL_API_KEY","GROQ_API_KEY","DEEPSEEK_API_KEY","OPENROUTER_API_KEY","LLM_PROVIDER","LLM_MODEL","LLM_API_KEY","LLM_BASE_URL"])if(process.env[key])env[key]=process.env[key];
  return env;
}
export function startProcess(context: AdapterContext, args: string[], extraEnv: NodeJS.ProcessEnv={}): ChildProcessWithoutNullStreams {
  if(context.target.kind==="container") return spawn("docker",["exec","-i","-w",context.session.workspace,context.target.container!,context.executable,...args],{stdio:"pipe",windowsHide:true});
  return spawn(context.executable,args,{cwd:context.session.workspace,env:{...harnessEnvironment(context.session.authMode==="native"),...extraEnv},stdio:"pipe",windowsHide:true});
}

/** JSONL transport. The process belongs to the Host, never to an HTTP subscriber. */
export class JsonPeer {
  private pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer?:ReturnType<typeof setTimeout>}>();
  private buffer=""; private closed=false; private stderrBytes=0; private decoder=new StringDecoder("utf8");
  constructor(readonly child: ChildProcessWithoutNullStreams,
    private event:(v:any)=>void,
    private serverRequest:(method:string,params:any,id:unknown)=>Promise<unknown>,
    private failure:(e:Error)=>void,
    private diagnostic:(text:string)=>void,
    private rpc=true, private maxRecordBytes=4*1024*1024) {
    child.stdout.on("data",chunk=>this.consume(chunk));
    child.stderr.on("data",(chunk:Buffer)=>{if(this.stderrBytes<16_384){this.stderrBytes+=chunk.length;this.diagnostic(String(redact(chunk.toString("utf8"))).slice(0,2048));}});
    child.once("error",e=>this.end(e));
    child.once("close",code=>this.end(new Error(`Harness process exited (${code ?? "signal"})`)));
    child.stdin.on("error",e=>this.end(e));
  }
  private consume(chunk:Buffer) {
    this.buffer+=this.decoder.write(chunk);
    for(;;) {
      const newline=this.buffer.indexOf("\n");if(newline<0)break;
      const line=this.buffer.slice(0,newline).trim();this.buffer=this.buffer.slice(newline+1);if(!line)continue;
      if(Buffer.byteLength(line)>this.maxRecordBytes){this.end(new Error("Harness protocol record exceeds its size limit"));this.close();return;}
      let v:any;try{v=JSON.parse(line);}catch{this.diagnostic("Ignored non-JSON harness output");continue;}
      const key=v.id===undefined?undefined:String(v.id);
      if(this.rpc && v.method && key!==undefined) {
        void this.serverRequest(v.method,v.params??{},v.id).then(result=>this.write({jsonrpc:"2.0",id:v.id,result}),error=>this.write({jsonrpc:"2.0",id:v.id,error:{code:-32603,message:String(redact(error?.message??"Client request failed"))}})).catch(()=>{});
      } else if(key && this.pending.has(key) && ("result" in v || "error" in v || v.type==="response")) {
        const p=this.pending.get(key)!;this.pending.delete(key);if(p.timer)clearTimeout(p.timer);
        if(v.error || v.success===false)p.reject(new HarnessRuntimeError(String(redact(v.error?.message??v.error??"Harness rejected command")),v.error?.code===-32800?499:422));
        else p.resolve(v.type==="response"?v.data:v.result);
      } else this.event(v);
    }
    if(Buffer.byteLength(this.buffer)>this.maxRecordBytes){this.end(new Error("Harness protocol record exceeds its size limit"));this.close();}
  }
  private write(value:unknown) {
    if(this.closed || this.child.stdin.destroyed) fail("Harness connection closed",409);
    this.child.stdin.write(JSON.stringify(value)+"\n");
  }
  request(method:string,params:Record<string,unknown>={},timeout=30_000):Promise<any> {
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=timeout ? setTimeout(()=>{this.pending.delete(id);reject(new Error(`Harness ${method} timed out; acceptance is unknown`));},timeout):undefined;
      timer?.unref();this.pending.set(id,{resolve,reject,timer});
      try{this.write(this.rpc?{jsonrpc:"2.0",id,method,params}:{id,type:method,...params});}catch(e){this.pending.delete(id);if(timer)clearTimeout(timer);reject(e);}
    });
  }
  notify(method:string,params:Record<string,unknown>={}) {this.write(this.rpc?{jsonrpc:"2.0",method,params}:{type:method,...params});}
  private end(error:Error) {
    if(this.closed)return;this.closed=true;
    for(const p of this.pending.values()){if(p.timer)clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.failure(error);
  }
  close() {
    const child=this.child;this.end(new Error("Harness connection closed"));
    child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
    child.kill("SIGTERM");if(child.exitCode===null){const timer=setTimeout(()=>{if(child.exitCode===null)child.kill("SIGKILL");},2000);child.once("exit",()=>clearTimeout(timer));}
  }
}
