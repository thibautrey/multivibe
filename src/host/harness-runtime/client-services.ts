import fs from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { harnessEnvironment } from "./process.js";
import { fail, redact, type AdapterContext } from "./types.js";

/** ACP client-side tools execute on the session's Host, scoped to its workspace. */
export class ClientServices {
  private terminals=new Map<string,{child:ChildProcessWithoutNullStreams;output:string;exitCode:number|null;done:Promise<unknown>}>();
  constructor(private ctx:AdapterContext) {}
  private async scoped(file:string,write=false) {
    const root=await fs.realpath(this.ctx.session.workspace);
    const requested=path.resolve(root,file);
    const resolved=write?path.join(await fs.realpath(path.dirname(requested)),path.basename(requested)):await fs.realpath(requested);
    if(resolved!==root && !resolved.startsWith(root+path.sep)) fail("Client filesystem access is outside the workspace",403);
    if(write){try{const st=await fs.lstat(resolved);if(st.isSymbolicLink())fail("Client writes cannot follow symlinks",403);}catch(e:any){if(e.code!=="ENOENT")throw e;}}
    return resolved;
  }
  async request(method:string,p:any):Promise<unknown> {
    if(p.sessionId && p.sessionId!==this.ctx.session.nativeSessionId) fail("Client request targets another session",403);
    if(method==="session/request_permission") {
      const answer=await this.ctx.ask("permission",p.toolCall?.title??"Autoriser cet outil ?",p);
      const choice=p.options?.find((v:any)=>v.optionId===answer.optionId);
      return {outcome:choice?{outcome:"selected",optionId:choice.optionId}:{outcome:"cancelled"}};
    }
    if(/elicitation|request_user_input/iu.test(method)) {
      const answer=await this.ctx.ask("question",p.message??p.title??"Une réponse est nécessaire",p);return answer;
    }
    if(method==="fs/read_text_file") {
      const file=await this.scoped(p.path);const st=await fs.stat(file);if(st.size>1024*1024)fail("File exceeds client text limit",413);
      const lines=(await fs.readFile(file,"utf8")).split("\n");const start=Math.max(0,(p.line??1)-1);return {content:lines.slice(start,start+Math.min(p.limit??lines.length,20_000)).join("\n")};
    }
    if(method==="fs/write_text_file") {
      const file=await this.scoped(p.path,true);if(typeof p.content!=="string" || Buffer.byteLength(p.content)>1024*1024)fail("Invalid client file content",413);
      const answer=await this.ctx.ask("permission",`Écrire ${path.relative(this.ctx.session.workspace,file)}`,{path:file,operation:"write",options:[{optionId:"allow",name:"Autoriser",kind:"allow_once"},{optionId:"deny",name:"Refuser",kind:"reject_once"}]});
      if(answer.optionId!=="allow")fail("File write denied",403);
      await fs.writeFile(file,p.content,{flag:"w",mode:0o600});return {};
    }
    if(method==="terminal/create") {
      if(typeof p.command!=="string" || !Array.isArray(p.args??[]) || (p.args??[]).some((v:any)=>typeof v!=="string"))fail("Invalid terminal command");
      const cwd=await this.scoped(p.cwd??this.ctx.session.workspace);
      const answer=await this.ctx.ask("permission",`Exécuter ${p.command}`,{command:p.command,args:p.args??[],cwd,options:[{optionId:"allow",name:"Autoriser",kind:"allow_once"},{optionId:"deny",name:"Refuser",kind:"reject_once"}]});
      if(answer.optionId!=="allow")fail("Terminal execution denied",403);
      const id=randomUUID();const child=spawn(p.command,p.args??[],{cwd,env:harnessEnvironment(),stdio:"pipe"});
      const terminal={child,output:"",exitCode:null as number|null,done:Promise.resolve({}) as Promise<unknown>};
      terminal.done=new Promise(resolve=>{child.once("close",code=>{terminal.exitCode=code;resolve({exitCode:code});});child.once("error",()=>resolve({exitCode:1}));});
      for(const stream of [child.stdout,child.stderr])stream.on("data",(chunk:Buffer)=>{terminal.output=(terminal.output+String(redact(chunk.toString()))).slice(-64_000);this.ctx.emit({type:"terminal.output",itemId:id,payload:{output:terminal.output}});});
      this.terminals.set(id,terminal);return {terminalId:id};
    }
    if(method.startsWith("terminal/")) {
      const terminal=this.terminals.get(p.terminalId);if(!terminal)fail("Terminal not found",404);
      if(method==="terminal/output")return {output:terminal.output,truncated:terminal.output.length>=64_000,...(terminal.exitCode!==null?{exitStatus:{exitCode:terminal.exitCode}}:{})};
      if(method==="terminal/wait_for_exit")return terminal.done;
      if(method==="terminal/kill"){terminal.child.kill("SIGTERM");return {};}
      if(method==="terminal/release"){terminal.child.kill("SIGTERM");this.terminals.delete(p.terminalId);return {};}
      if(method==="terminal/write_stdin"){terminal.child.stdin.write(String(p.data??""));return {};}
    }
    fail(`Client method is unsupported: ${method}`,422);
  }
  close(){for(const t of this.terminals.values())t.child.kill("SIGTERM");this.terminals.clear();}
}
