import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";

export type NativeSessionSource={sourceId:string;harnessId:string;nativeSessionId:string;title:string;workspace?:string;updatedAt:number;canContinue:boolean;strategy:"isolated_fork"|"read_only";reason?:string;file?:string};
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
