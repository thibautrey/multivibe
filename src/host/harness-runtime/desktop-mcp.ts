import readline from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { callDesktop, DESKTOP_TOOLS } from "./desktop-tools.js";

/** Standard JSONL MCP transport. stdout contains protocol frames only. */
export async function serveDesktopMcp() {
  const socket=process.env.MULTIVIBE_DESKTOP_SOCKET,token=process.env.MULTIVIBE_DESKTOP_TOKEN;
  if(!socket || !token)throw new Error("Desktop capability was not provisioned by MultiVibe Host");
  const write=(value:unknown)=>process.stdout.write(JSON.stringify(value)+"\n");
  const calls=new Map<string,AbortController>();
  const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
  for await(const line of lines) {
    if(Buffer.byteLength(line)>32_000)throw new Error("Desktop MCP input too large");
    let req:any;try{req=JSON.parse(line);}catch{write({jsonrpc:"2.0",id:null,error:{code:-32700,message:"Invalid JSON"}});continue;}
    if(req.method==="notifications/cancelled"){calls.get(String(req.params?.requestId))?.abort();continue;}
    if(req.id===undefined)continue;
    void(async()=>{
      let result:unknown;
      if(req.method==="initialize")result={protocolVersion:["2024-11-05","2025-03-26","2025-06-18"].includes(req.params?.protocolVersion)?req.params.protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"multivibe-desktop",version:"1.0.0"},instructions:"These tools act on the MultiVibe Host, not the harness machine. Use its integrated browser for browsing. Each action needs a fresh observation. Host handles user approvals and exclusive graphical access."};
      else if(req.method==="ping")result={};
      else if(req.method==="tools/list")result={tools:DESKTOP_TOOLS};
      else if(req.method==="tools/call") {
        const controller=new AbortController();calls.set(String(req.id),controller);
        try{result=await callDesktop({socket,token},req.params?.name,req.params?.arguments??{},controller.signal);}catch(error:any){result={isError:true,content:[{type:"text",text:error.message}]};}finally{calls.delete(String(req.id));}
      } else {write({jsonrpc:"2.0",id:req.id,error:{code:-32601,message:"Method not found"}});return;}
      write({jsonrpc:"2.0",id:req.id,result});
    })().catch(error=>write({jsonrpc:"2.0",id:req.id,error:{code:-32603,message:error.message}}));
  }
  for(const c of calls.values())c.abort();
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))serveDesktopMcp().catch(()=>{process.exitCode=1;});
