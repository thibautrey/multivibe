import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { fail } from "./types.js";

export type DesktopConnection = { command:string; args:string[]; env:Record<string,string> };
export type DesktopContent = {type:"text";text:string}|{type:"image";mimeType:string;data:string};
export type DesktopResult = {content:DesktopContent[];isError?:boolean};
const actions = ["list_apps","observe","navigate","click","double_click","type","key","scroll","drag","back"];
const properties = {
  action:{type:"string",enum:actions},target:{type:"string",description:"macOS application bundle ID; browser for the integrated Chromium browser"},
  observation:{type:"string",description:"ID of the latest observation of this target; required before input"},
  element:{type:"integer",minimum:1},text:{type:"string",maxLength:16000},key:{type:"string"},url:{type:"string"},
  x:{type:"number"},y:{type:"number"},toX:{type:"number"},toY:{type:"number"},amount:{type:"integer"},direction:{type:"string",enum:["up","down","left","right"]},
};
const description = "Provided by MultiVibe Host, independent of the selected harness. Observe before acting and use the returned observation ID. Actions return fresh page/app text and a screenshot. Host manages site/app consent, macOS permissions and user takeover. Never infer success from an error. Keys: return, tab, escape, backspace, delete, up, down, left, right, home, end, pageup, pagedown, select_all, copy, paste, undo, redo.";
export const DESKTOP_TOOLS = [
  {name:"browser",description:"Control Host's integrated Chromium browser. "+description,inputSchema:{type:"object",properties,required:["action"],additionalProperties:false}},
  {name:"computer",description:"List and control macOS applications on the Host. Use list_apps to discover targets. "+description,inputSchema:{type:"object",properties,required:["action"],additionalProperties:false}},
];
type Pending = {id:string;command:Record<string,unknown>;delivered:boolean;resolve:(v:DesktopResult)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>};
type Session = {token:string;lease?:string;seen:number;pending?:Pending;release:boolean;wait?:()=>void};

/** Only the native Desktop provider has the admin route. Harnesses get a per-session
 * capability over a private Unix socket, never the Host's admin/model credentials. */
export class DesktopTools {
  private sessions = new Map<string,Session>();
  private directory?:string;
  private server?:http.Server;
  private starting?:Promise<void>;
  private closed=false;
  constructor(private active:(id:string)=>boolean,private timeout=180_000) {}
  available(id:string) {const s=this.sessions.get(id);return Boolean(s?.lease && (Date.now()-s.seen<45_000 || s.pending?.delivered));}
  attach(id:string,lease?:unknown) {
    if(this.closed)fail("Desktop provider is closed",409);
    let s=this.sessions.get(id);
    if(!s){s={token:randomBytes(32).toString("hex"),seen:0,release:false};this.sessions.set(id,s);}
    if(this.available(id) && s.lease!==lease)fail("Another Desktop provider owns this session",409);
    if(s.lease!==lease){this.cancel(id);s.lease=randomBytes(32).toString("hex");}
    s.seen=Date.now();return {lease:s.lease};
  }
  private provider(id:string,lease:unknown) {
    const s=this.sessions.get(id);if(!s?.lease || typeof lease!=="string" || s.lease!==lease)fail("Desktop provider lease is invalid",403);
    s.seen=Date.now();return s;
  }
  async next(id:string,lease:unknown,signal?:AbortSignal) {
    const s=this.provider(id,lease);
    if(s.wait)fail("A Desktop request poll is already active",409);
    if(!s.release && (!s.pending || s.pending.delivered) && !signal?.aborted)await new Promise<void>(resolve=>{
      const done=()=>{clearTimeout(timer);signal?.removeEventListener("abort",done);s.wait=undefined;resolve();};
      const timer=setTimeout(done,20_000);s.wait=done;signal?.addEventListener("abort",done,{once:true});
    });
    // Re-check ownership after a suspended poll; an expired provider cannot claim work.
    this.provider(id,lease);
    if(s.release){s.release=false;return {release:true};}
    if(!s.pending || s.pending.delivered)return {};
    s.pending.delivered=true;return {id:s.pending.id,command:s.pending.command};
  }
  complete(id:string,lease:unknown,requestId:unknown,result:unknown) {
    const s=this.provider(id,lease),p=s.pending;
    if(!p || !p.delivered || p.id!==requestId)fail("Desktop request expired or belongs to another session",409);
    const checked=desktopResult(result);clearTimeout(p.timer);s.pending=undefined;p.resolve(checked);
  }
  cancel(id:string,reason="Desktop action interrupted; observe again before retrying") {
    const s=this.sessions.get(id);if(!s)return;
    if(s.pending){clearTimeout(s.pending.timer);s.pending.reject(new Error(reason));s.pending=undefined;}
    s.release=true;s.wait?.();
  }
  detach(id:string,lease:unknown) {this.provider(id,lease);this.cancel(id,"Desktop provider disconnected");this.sessions.get(id)!.lease=undefined;}
  async call(id:string,name:string,args:unknown):Promise<DesktopResult> {
    const s=this.sessions.get(id);
    if(!this.available(id) || !s)fail("Open this conversation in MultiVibe Desktop to use Host browser/computer tools",409);
    if(!this.active(id))fail("Desktop tools require an active turn in this session",409);
    if(s.pending)fail("A Desktop action is already pending in this session",409);
    if(!DESKTOP_TOOLS.some(t=>t.name===name) || !args || typeof args!=="object" || Array.isArray(args))fail("Invalid Desktop tool call");
    const command={...args as Record<string,unknown>};
    if(Object.keys(command).some(k=>!(k in properties)) || !actions.includes(String(command.action)) || Buffer.byteLength(JSON.stringify(command))>24_000)fail("Invalid Desktop command");
    if(name==="browser") {if(command.target!==undefined && command.target!=="browser")fail("Browser tools cannot control other applications",403);command.target="browser";if(command.action==="list_apps")fail("Use computer to list macOS apps");}
    return new Promise((resolve,reject)=>{
      const p:Pending={id:randomUUID(),command,delivered:false,resolve,reject,timer:setTimeout(()=>{this.cancel(id,"Desktop action timed out; acceptance is unknown. Observe before continuing.");},this.timeout)};
      s.pending=p;s.wait?.();
    });
  }
  async connection(id:string):Promise<DesktopConnection> {
    if(!this.sessions.has(id))fail("Desktop provider is not attached",409);
    await this.listen();
    const source=import.meta.url.endsWith(".ts"),entry=fileURLToPath(new URL(source?"./desktop-mcp.ts":"./desktop-mcp.js",import.meta.url));
    return {command:process.execPath,args:[...(source?["--import","tsx"]:[]),entry],env:{MULTIVIBE_DESKTOP_SOCKET:path.join(this.directory!,"tools.sock"),MULTIVIBE_DESKTOP_TOKEN:this.sessions.get(id)!.token}};
  }
  private async listen() {
    if(this.closed)fail("Desktop broker closed",409);
    if(this.starting)return this.starting;
    this.starting=(async()=>{
      this.directory=fs.mkdtempSync(path.join(os.tmpdir(),"mv-desktop-"));fs.chmodSync(this.directory,0o700);
      this.server=http.createServer((req,res)=>{void (async()=>{
        if(req.method!=="POST" || req.url!=="/call")fail("Unknown Desktop endpoint",404);
        const entry=[...this.sessions].find(([,s])=>req.headers.authorization===`Bearer ${s.token}`);if(!entry)fail("Invalid Desktop session",403);
        const chunks:Buffer[]=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>24_000)fail("Desktop command exceeds its limit",413);chunks.push(chunk);}
        const input=JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const pending=this.call(entry[0],input.name,input.arguments),requestId=entry[1].pending?.id;
        const disconnected=()=>{if(!res.writableEnded && requestId && entry[1].pending?.id===requestId)this.cancel(entry[0],"Harness cancelled the Desktop action; do not replay input");};
        res.once("close",disconnected);
        try {const result=await pending;res.setHeader("content-type","application/json");res.end(JSON.stringify(result));}
        finally{res.off("close",disconnected);}
      })().catch(error=>{if(!res.destroyed){res.statusCode=error.status??400;res.setHeader("content-type","application/json");res.end(JSON.stringify({content:[{type:"text",text:String(error.message)}],isError:true}));}});});
      await new Promise<void>((resolve,reject)=>{this.server!.once("error",reject);this.server!.listen(path.join(this.directory!,"tools.sock"),()=>{fs.chmodSync(path.join(this.directory!,"tools.sock"),0o600);resolve();});});
    })();return this.starting;
  }
  close() {
    this.closed=true;for(const id of this.sessions.keys())this.cancel(id,"Desktop Host closed");
    this.server?.closeAllConnections();this.server?.close();this.sessions.clear();
    if(this.directory)fs.rmSync(this.directory,{recursive:true,force:true});
  }
}

function desktopResult(input:unknown):DesktopResult {
  const v=input as DesktopResult;
  if(!v || !Array.isArray(v.content) || !v.content.length || v.content.length>3 || JSON.stringify(v).length>5_000_000 ||
    v.content.some(c=>c.type==="text"?typeof c.text!=="string" || c.text.length>40_000:c.type!=="image" || !["image/jpeg","image/png"].includes(c.mimeType) || typeof c.data!=="string" || !/^[A-Za-z0-9+/]*={0,2}$/u.test(c.data)))fail("Invalid Desktop result");
  return {content:v.content,isError:v.isError===true};
}

export function callDesktop(connection:{socket:string;token:string},name:string,args:unknown,signal?:AbortSignal):Promise<DesktopResult> {
  return new Promise((resolve,reject)=>{
    const request=http.request({socketPath:connection.socket,path:"/call",method:"POST",signal,headers:{authorization:`Bearer ${connection.token}`,"content-type":"application/json"}},response=>{
      const chunks:Buffer[]=[];let size=0;response.on("data",(chunk:Buffer)=>{size+=chunk.length;if(size>5_000_000){request.destroy(new Error("Desktop result exceeds limit"));return;}chunks.push(chunk);});
      response.on("end",()=>{try{resolve(desktopResult(JSON.parse(Buffer.concat(chunks).toString("utf8"))));}catch(e){reject(e);}});response.on("error",reject);
    });request.setTimeout(185_000,()=>request.destroy(new Error("Desktop transport timed out; do not replay input")));request.on("error",reject);request.end(JSON.stringify({name,arguments:args}));
  });
}
