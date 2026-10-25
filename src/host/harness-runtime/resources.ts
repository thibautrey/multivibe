import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fail, type HarnessSession } from "./types.js";

export type HarnessResource={path:string;name:string;scope:string;exists:boolean;writable:boolean;sha256:string;text:string;truncated?:boolean};
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
export function harnessResources(session:HarnessSession,kind:"memory"|"instructions",home=os.homedir()):HarnessResource[] {
  const entries:Array<{file:string;scope:string;writable:boolean}>=[];
  const add=(file:string,scope:string,writable=false)=>entries.push({file,scope,writable});
  if(kind==="memory") {
    if(session.harnessId==="hermes-agent")for(const name of ["MEMORY.md","USER.md"])add(path.join(process.env.HERMES_HOME??path.join(home,".hermes"),"memories",name),"user",true);
    if(session.harnessId==="claude-code")add(path.join(process.env.CLAUDE_CONFIG_DIR??path.join(home,".claude"),"projects",session.workspace.replace(/[^a-zA-Z0-9]/gu,"-"),"memory/MEMORY.md"),"project",true);
    if(session.harnessId==="openai-codex")for(const name of ["memory_summary.md","MEMORY.md"])add(path.join(process.env.CODEX_HOME??path.join(home,".codex"),"memories",name),"user");
  } else {
    const global:Record<string,string>={"openai-codex":".codex/AGENTS.md","claude-code":".claude/CLAUDE.md",pi:".pi/agent/AGENTS.md","hermes-agent":".hermes/AGENTS.md","gemini-cli":".gemini/GEMINI.md",opencode:".config/opencode/AGENTS.md"};
    if(global[session.harnessId])add(path.join(home,global[session.harnessId]),"user");
    const directories:string[]=[];for(let dir=session.workspace;;dir=path.dirname(dir)){directories.unshift(dir);if(path.dirname(dir)===dir || directories.length>=32)break;}
    for(const dir of directories)for(const name of ["AGENTS.md",...(session.harnessId==="claude-code"?["CLAUDE.md"]:session.harnessId==="gemini-cli"?["GEMINI.md"]:[])])add(path.join(dir,name),"project");
  }
  return entries.flatMap(({file,scope,writable})=>{
    try {const st=fs.lstatSync(file);if(!st.isFile() || st.isSymbolicLink() || st.size>512*1024)return [];const text=fs.readFileSync(file,"utf8");const truncated=st.size>120_000;return [{path:file,name:path.basename(file),scope,exists:true,writable:writable&&!truncated,sha256:hash(text),text:truncated?text.slice(0,30_000):text,...(truncated?{truncated:true}:{})}];}
    catch(e:any){return e.code==="ENOENT" && writable?[{path:file,name:path.basename(file),scope,exists:false,writable,sha256:hash(""),text:""}]:[];}
  });
}
export function writeHarnessResource(session:HarnessSession,value:any) {
  if(value.kind!=="memory")fail("Only explicitly editable memory resources can be changed",422);
  const resource=harnessResources(session,"memory").find(v=>v.path===value.path && v.writable);
  if(!resource)fail("This path is not an editable native memory resource",403);
  if(resource.sha256!==value.sha256)fail("The harness changed this memory; reload it before saving",409);
  if(typeof value.text!=="string" || Buffer.byteLength(value.text)>512*1024)fail("Memory exceeds its size limit",413);
  const directory=path.dirname(resource.path);fs.mkdirSync(directory,{recursive:true,mode:0o700});
  if(fs.existsSync(resource.path) && fs.lstatSync(resource.path).isSymbolicLink())fail("Memory writes cannot follow symlinks",403);
  const backup=resource.path+".before-multivibe";
  if(resource.exists && !fs.existsSync(backup)){fs.copyFileSync(resource.path,backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(backup,0o600);}
  const temporary=path.join(directory,`.multivibe-memory-${randomUUID()}`);
  try{fs.writeFileSync(temporary,value.text,{mode:0o600,flag:"wx"});fs.renameSync(temporary,resource.path);}finally{try{fs.unlinkSync(temporary);}catch{}}
  return {path:resource.path,sha256:hash(value.text),saved:true};
}
