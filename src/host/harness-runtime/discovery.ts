import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { fail, redact } from "./types.js";

export type NativeSessionSource={sourceId:string;harnessId:string;nativeSessionId:string;title:string;workspace?:string;updatedAt:number;canContinue:boolean;strategy:"isolated_fork"|"read_only";reason?:string;file?:string};
export type HarnessProject={id:string;harnessId:string;name:string;path:string;updatedAt:number};
export const PROJECT_HARNESS_IDS=new Set(["hermes-agent","pi","openai-codex","claude-code","opencode","gemini-cli"]);
// Cache metadata only; unchanged transcript files are not re-read on every catalog poll.
const metadataCache=new Map<string,{mtime:number;size:number;nativeId:string;title:string;workspace?:string}>();
/** Read native metadata only. Authentication/configuration files are never scanned. */
export function discoverNativeSessionPage(harnessId:string,home=os.homedir(),page=0):{sessions:NativeSessionSource[];hasMore:boolean} {
  if(!Number.isSafeInteger(page) || page<0 || page>1000)fail("Invalid native catalog page");
  const result:NativeSessionSource[]=[];
  let hasMore=false;
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
        const order=["time_updated","updated_at","started_at"].find(c=>columns.has(c));
        const rows=names.includes("id")?db.prepare(`SELECT ${names.join(",")} FROM ${table} ORDER BY ${order?`${order} DESC,`:""}id LIMIT 501 OFFSET ?`).all(page*500):[];
        hasMore=rows.length>500;
        for(const row of rows.slice(0,500)){
          const value=row.time_updated??row.updated_at??row.started_at??0;
          const updated=Number(value)||Date.parse(String(value))||0;
          add(String(row.id),row.title??row.id,row.cwd??row.directory,updated>0 && updated<1e12?updated*1000:updated);
        }
      }catch{/* A changed native schema is not interpreted as empty history proof. */}finally{db?.close();}
    }
    return {sessions:result.sort((a,b)=>b.updatedAt-a.updatedAt),hasMore};
  }
  const roots:Record<string,string>={pi:".pi/agent/sessions","openai-codex":".codex/sessions","claude-code":".claude/projects","gemini-cli":".gemini/tmp"};
  const relative=roots[harnessId];if(!relative)return {sessions:[],hasMore:false};
  const titles=new Map<string,string>();
  if(harnessId==="openai-codex")try{
    const index=path.join(home,".codex/session_index.jsonl");
    if(fs.statSync(index).size<=8*1024*1024)for(const line of fs.readFileSync(index,"utf8").split("\n"))try{const row=JSON.parse(line);if(typeof row.id==="string" && typeof row.thread_name==="string")titles.set(row.id,row.thread_name);}catch{}
  }catch{/* Older Codex versions have no title index. */}
  let visited=0;
  const start=page*5000,end=start+5000;
  const visit=(directory:string,depth:number)=>{
    if(depth>6 || visited>end)return;
    let entries:fs.Dirent[];try{entries=fs.readdirSync(directory,{withFileTypes:true});}catch{return;}
    // Date-based native directories must be visited newest first before applying limits.
    entries.sort((a,b)=>b.name.localeCompare(a.name));
    for(const entry of entries){if(++visited>end){hasMore=true;break;}if(entry.isSymbolicLink())continue;const file=path.join(directory,entry.name);
      if(entry.isDirectory()){visit(file,depth+1);continue;}
      if(visited<=start)continue;
      if(!/\.(jsonl|json)$/u.test(entry.name))continue;
      let fd:number|undefined;
      try {const st=fs.statSync(file),cacheKey=harnessId+":"+file,cached=metadataCache.get(cacheKey);
        if(cached && cached.mtime===st.mtimeMs && cached.size===st.size){add(cached.nativeId,titles.get(cached.nativeId)??cached.title,cached.workspace,st.mtimeMs,file);continue;}
        if(entry.name.endsWith(".json") && st.size>16*1024*1024)continue;fd=fs.openSync(file,"r");const buffer=Buffer.alloc(Math.min(st.size,entry.name.endsWith(".json")?16*1024*1024:128*1024));fs.readSync(fd,buffer,0,buffer.length,0);const first=buffer.toString("utf8").split("\n").find(v=>v.trim());if(!first)continue;
        const records=entry.name.endsWith(".json")?[JSON.parse(buffer.toString("utf8"))]:buffer.toString("utf8").split("\n").flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
        const record=records.find(v=>v.sessionId || v.session_id || v.type==="session_meta" || v.type==="session" || v.cwd)??JSON.parse(first);
        const meta=record.payload??record;
        const nativeId=meta.sessionId??meta.session_id??meta.id;
        const title=meta.title??meta.name??records.find(v=>v.type==="session_info" && typeof v.name==="string")?.name??path.basename(file);
        if(typeof nativeId==="string"){
          const value={mtime:st.mtimeMs,size:st.size,nativeId:harnessId==="pi"?file:nativeId,title,workspace:typeof meta.cwd==="string"?meta.cwd:undefined};
          if(metadataCache.size>=10000)metadataCache.delete(metadataCache.keys().next().value!);metadataCache.set(cacheKey,value);
          add(value.nativeId,titles.get(value.nativeId)??title,value.workspace,st.mtimeMs,file);
        }
      }catch{/* Ignore incomplete or unsupported records without exposing transcript text. */}finally{if(fd!==undefined)fs.closeSync(fd);}
    }
  };
  visit(path.join(home,relative),0);return {sessions:result.sort((a,b)=>b.updatedAt-a.updatedAt),hasMore};
}
export function discoverNativeSessions(harnessId:string,home=os.homedir()):NativeSessionSource[]{return discoverNativeSessionPage(harnessId,home).sessions;}
export function findNativeSession(harnessId:string,sourceId:string,home=os.homedir()):NativeSessionSource|undefined {
  for(let page=0;page<=1000;page++){
    const result=discoverNativeSessionPage(harnessId,home,page),source=result.sessions.find(v=>v.sourceId===sourceId);
    if(source || !result.hasMore)return source;
  }
  fail("Native catalog exceeds its page limit",413);
}

export type NativeHistoryMessage={id:string;role:string;content:string;done:boolean};
const decode=(value:any)=>{if(typeof value!=="string")return value;try{return JSON.parse(value);}catch{return value;}};
function textContent(value:any):string {
  if(typeof value==="string")return value;
  if(Array.isArray(value))return value.map(textContent).filter(Boolean).join("\n\n");
  if(!value || typeof value!=="object")return "";
  if(value.type===undefined || ["text","input_text","output_text"].includes(value.type))return typeof value.text==="string"?value.text:"";
  return "";
}

/** Reading history never creates a runtime session or starts/acquires a native process. */
export function readNativeMessages(harnessId:string,sourceId:string,home=os.homedir()) {
  const source=findNativeSession(harnessId,sourceId,home);if(!source)fail("Native session not found",404);
  let records:any[]=[];
  if(source.file){
    const stat=fs.lstatSync(source.file);if(!stat.isFile() || stat.size>16*1024*1024)fail("Native history exceeds 16 MiB; inspect it in its native tool",413);
    const text=fs.readFileSync(source.file,"utf8");
    if(source.file.endsWith(".jsonl"))records=text.split("\n").flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
    else {try{const value=JSON.parse(text);records=Array.isArray(value.messages)?value.messages:[];}catch{fail("Native history is still being written; retry shortly",409);}}
    // Pi histories are trees: only expose the active (last) branch, including non-message nodes.
    if(harnessId==="pi"){
      const nodes=new Map(records.filter(v=>typeof v.id==="string").map(v=>[v.id,v]));
      const branch:any[]=[],seen=new Set<string>();let node=records.at(-1);
      while(node && typeof node.id==="string" && !seen.has(node.id)){seen.add(node.id);branch.unshift(node);node=nodes.get(node.parentId);}
      if(branch.length>1)records=branch;
    }
  }else{
    const file=harnessId==="hermes-agent"?path.join(home,".hermes/state.db"):path.join(home,".local/share/opencode/opencode.db");
    const db=new Database(file,{readonly:true,fileMustExist:true});
    try{
      if(harnessId==="hermes-agent")records=db.prepare("SELECT rowid AS row_id, * FROM messages WHERE session_id=? ORDER BY rowid LIMIT 20001").all(source.nativeSessionId);
      else {
        const messages=db.prepare("SELECT id, data FROM message WHERE session_id=? ORDER BY rowid LIMIT 20001").all(source.nativeSessionId) as any[];
        const parts=db.prepare("SELECT message_id, data FROM part WHERE session_id=? ORDER BY rowid LIMIT 50001").all(source.nativeSessionId) as any[];
        if(parts.length>50000)fail("Native history exceeds its part limit",413);
        const content=new Map<string,any[]>();for(const part of parts){const values=content.get(part.message_id)??[];values.push(decode(part.data));content.set(part.message_id,values);}
        records=messages.map(row=>({id:row.id,...decode(row.data),content:content.get(row.id)??[]}));
      }
    }finally{db.close();}
  }
  if(records.length>20000)fail("Native history exceeds 20000 records",413);
  const messages:NativeHistoryMessage[]=[];
  for(const [index,record] of records.entries()){
    if(record.isSidechain===true)continue;
    const message=harnessId==="openai-codex"?(record.type==="response_item"?record.payload:null):record.message??record;
    if(!message)continue;
    const role=message.role??(message.type==="gemini"?"assistant":message.type==="user"?"user":undefined);
    if(!["user","assistant","system","tool"].includes(role))continue;
    const content=textContent(decode(message.content));if(!content)continue;
    messages.push({id:String(record.uuid??record.id??record.row_id??`native-${index}`),role,content:String(redact(content)),done:true});
  }
  if(Buffer.byteLength(JSON.stringify(messages))>24*1024*1024)fail("Native history exceeds its response limit",413);
  const {file:_,...metadata}=source;
  return {source:metadata,messages,revision:createHash("sha256").update(JSON.stringify(messages)).digest("hex"),readOnly:true};
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
  const source=findNativeSession(harnessId,sourceId,home);if(!source)fail("Native session not found",404);
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
