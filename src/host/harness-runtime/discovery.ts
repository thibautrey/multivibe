import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { fail, redact } from "./types.js";

export type NativeSessionSource={sourceId:string;harnessId:string;nativeSessionId:string;title:string;workspace?:string;updatedAt:number;canContinue:boolean;strategy:"isolated_fork"|"read_only";reason?:string;file?:string};
export type HarnessProject={id:string;harnessId:string;name:string;path:string;updatedAt:number};
export const PROJECT_HARNESS_IDS=new Set(["hermes-agent","pi","openai-codex","claude-code","opencode","gemini-cli"]);
/** Read native metadata only. Authentication/configuration files are never scanned. */
export function discoverNativeSessions(harnessId:string,home=os.homedir()):NativeSessionSource[] {
  const result:NativeSessionSource[]=[];
  const add=(nativeSessionId:string,title:string,workspace:string|undefined,updatedAt:number,file?:string)=>{
    if(!nativeSessionId || nativeSessionId.length>4096)return;
    const canContinue=["pi","claude-code","openai-codex","opencode"].includes(harnessId);
    result.push({sourceId:createHash("sha256").update(`${harnessId}:${nativeSessionId}`).digest("hex"),harnessId,nativeSessionId,title:title.slice(0,200),workspace,updatedAt,canContinue,strategy:canContinue?"isolated_fork":"read_only",...(!canContinue?{reason:"This adapter does not advertise an isolated native fork"}:{}),...(file?{file}:{})});
  };
  if(harnessId==="hermes-agent" || harnessId==="opencode") {
    const database=harnessId==="hermes-agent"?path.join(home,".hermes/state.db"):path.join(home,".local/share/opencode/opencode.db");
    if(fs.existsSync(database)) {
      let db:any;
      try {db=new Database(database,{readonly:true,fileMustExist:true});const table=harnessId==="hermes-agent"?"sessions":"session";
        const columns=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r:any)=>r.name));
        const names=["id","title","cwd","directory","updated_at","started_at","time_updated"].filter(c=>columns.has(c));
        if(names.includes("id"))for(const row of db.prepare(`SELECT ${names.join(",")} FROM ${table} LIMIT 500`).all())add(row.id,row.title??row.id,row.cwd??row.directory,Number(row.time_updated??row.updated_at??row.started_at??0));
      }catch{/* A changed native schema is not interpreted as empty history proof. */}finally{db?.close();}
    }
    return result.sort((a,b)=>b.updatedAt-a.updatedAt);
  }
  const roots:Record<string,string>={pi:".pi/agent/sessions","openai-codex":".codex/sessions","claude-code":".claude/projects","gemini-cli":".gemini/tmp"};
  const relative=roots[harnessId];if(!relative)return [];
  let visited=0;
  const visit=(directory:string,depth:number)=>{
    if(depth>6 || visited>5000 || result.length>=500)return;
    let entries:fs.Dirent[];try{entries=fs.readdirSync(directory,{withFileTypes:true});}catch{return;}
    for(const entry of entries){if(++visited>5000)break;if(entry.isSymbolicLink())continue;const file=path.join(directory,entry.name);
      if(entry.isDirectory()){visit(file,depth+1);continue;}
      if(!/\.(jsonl|json)$/u.test(entry.name))continue;
      let fd:number|undefined;
      try {const st=fs.statSync(file);fd=fs.openSync(file,"r");const buffer=Buffer.alloc(Math.min(st.size,128*1024));fs.readSync(fd,buffer,0,buffer.length,0);const first=buffer.toString("utf8").split("\n").find(v=>v.trim());if(!first)continue;
        const record=JSON.parse(first);const meta=record.payload??record;
        const nativeId=meta.sessionId??meta.session_id??meta.id;
        if(typeof nativeId==="string")add(harnessId==="pi"?file:nativeId,meta.title??meta.name??path.basename(file),typeof meta.cwd==="string"?meta.cwd:undefined,st.mtimeMs,file);
      }catch{/* Ignore incomplete or unsupported records without exposing transcript text. */}finally{if(fd!==undefined)fs.closeSync(fd);}
    }
  };
  visit(path.join(home,relative),0);return result.sort((a,b)=>b.updatedAt-a.updatedAt);
}

/** Aggregate project directories from native session metadata without reading transcript content. */
export function discoverHarnessProjects(harnessId:string,home=os.homedir()):HarnessProject[] {
  if(!PROJECT_HARNESS_IDS.has(harnessId))return [];
  const projects=new Map<string,HarnessProject>();
  for(const source of discoverNativeSessions(harnessId,home)){
    if(!source.workspace || !path.isAbsolute(source.workspace))continue;
    let workspace:string;
    try{workspace=fs.realpathSync(source.workspace);if(!fs.statSync(workspace).isDirectory())continue;}catch{continue;}
    const prior=projects.get(workspace),updatedAt=Math.max(0,source.updatedAt||0);
    if(prior){if(updatedAt>prior.updatedAt)prior.updatedAt=updatedAt;continue;}
    projects.set(workspace,{id:createHash("sha256").update(`${harnessId}:${workspace}`).digest("hex"),harnessId,name:path.basename(workspace)||workspace,path:workspace,updatedAt});
  }
  return [...projects.values()].sort((a,b)=>b.updatedAt-a.updatedAt||a.name.localeCompare(b.name)).slice(0,200);
}

/** Explicit read-only preview. Native processes and their session ownership are never acquired. */
export function readNativeSession(harnessId:string,sourceId:string,home=os.homedir(),after=0) {
  if(!Number.isSafeInteger(after) || after<0)fail("Invalid native history cursor");
  const source=discoverNativeSessions(harnessId,home).find(s=>s.sourceId===sourceId);if(!source)fail("Native session not found",404);
  let records:unknown[]=[];let complete=true;
  if(source.file){
    const stat=fs.lstatSync(source.file);if(!stat.isFile() || stat.size>16*1024*1024)fail("Native preview exceeds 16 MiB; use the native CLI to inspect it",413);
    const text=fs.readFileSync(source.file,"utf8");
    if(source.file.endsWith(".jsonl")){
      const lines=text.split("\n").filter(v=>v.trim());const page=lines.slice(after,after+100);
      records=page.map(line=>{try{return JSON.parse(line);}catch{return {incomplete:true};}});complete=after+page.length>=lines.length;
    }else{if(after)records=[];else try{records=[JSON.parse(text)];}catch{fail("The native session is incomplete; retry after its writer finishes",409);}}
  }else{
    const file=harnessId==="hermes-agent"?path.join(home,".hermes/state.db"):path.join(home,".local/share/opencode/opencode.db");
    const table=harnessId==="hermes-agent"?"messages":"part";const db=new Database(file,{readonly:true,fileMustExist:true});
    try{
      const columns=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r:any)=>r.name));
      if(!columns.has("session_id"))fail("This native database schema does not expose a supported read-only transcript",422);
      const fields=["id","role","content","data","tool_calls","tool_call_id"].filter(name=>columns.has(name));if(!fields.length)fail("Native transcript fields are unavailable",422);
      const rows=db.prepare(`SELECT ${fields.join(",")} FROM ${table} WHERE session_id=? ORDER BY rowid LIMIT 101 OFFSET ?`).all(source.nativeSessionId,after) as any[];
      complete=rows.length<=100;records=rows.slice(0,100).map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>{if(typeof value==="string")try{return [key,JSON.parse(value)];}catch{}return [key,value];})));
    }finally{db.close();}
  }
  const {file:_,...metadata}=source;
  return {source:metadata,records:redact(records),cursor:after+records.length,complete,readOnly:true};
}
