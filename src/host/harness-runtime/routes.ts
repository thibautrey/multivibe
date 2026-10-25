import express from "express";
import { randomUUID } from "node:crypto";
import { HostHarnessRuntime, ADAPTERS } from "./runtime.js";
import { RemoteHarnessHosts } from "./remote.js";
import { discoverNativeSessions, readNativeSession } from "./discovery.js";
import { fail, redact, type HarnessTarget } from "./types.js";

export function harnessRuntimeRoutes(runtime?:HostHarnessRuntime,remotes=new RemoteHarnessHosts()) {
  const router=express.Router();
  router.use(express.json({limit:"24mb"}));
  router.use((_req,res,next)=>{res.setHeader("cache-control","no-store");if(!runtime)return res.status(404).json({error:"Harness runtime is available only on a MultiVibe Host"});next();});
  const route=(fn:(req:express.Request,res:express.Response)=>Promise<unknown>|unknown):express.RequestHandler=>(req,res,next)=>{Promise.resolve().then(()=>fn(req,res)).catch(next);};
  const remote=(req:express.Request):HarnessTarget|undefined=>{const id=String(req.query.targetId??"local");const target=runtime!.store.target(id);return target.kind==="ssh" || target.kind==="container" && target.bridgePath?target:undefined;};
  const proxy=async(req:express.Request,method:string,p:string,body?:unknown)=>{const target=remote(req);return target?remotes.request(target,method,p,body):undefined;};
  router.get("/catalog",route(async(req,res)=>res.json(await proxy(req,"GET","/catalog")??{harnesses:await runtime!.catalog(String(req.query.targetId??"local"))})));
  router.get("/librechat",route(async(req,res)=>res.json(await proxy(req,"GET","/librechat")??runtime!.librechat.publicConfiguration())));
  router.post("/librechat",route(async(req,res)=>res.json(await proxy(req,"POST","/librechat",req.body)??await runtime!.librechat.configure(req.body))));
  router.get("/openwebui",route(async(req,res)=>res.json(await proxy(req,"GET","/openwebui")??runtime!.openwebui.publicConfiguration())));
  router.post("/openwebui",route(async(req,res)=>res.json(await proxy(req,"POST","/openwebui",req.body)??await runtime!.openwebui.configure(req.body))));
  router.post("/models",route(async(req,res)=>res.json(await proxy(req,"POST","/models",{...req.body,targetId:"local"})??await runtime!.models({...req.body,targetId:String(req.query.targetId??"local")}))));
  router.get("/remote-chats",route(async(req,res)=>{
    const query=`?harnessId=${encodeURIComponent(String(req.query.harnessId??""))}`;
    return res.json(await proxy(req,"GET","/remote-chats"+query)??await runtime!.remoteChats(req.query.harnessId).list());
  }));
  router.get("/remote-chats/:chatId",route(async(req,res)=>{
    const query=`?harnessId=${encodeURIComponent(String(req.query.harnessId??""))}`;
    const forwarded=await proxy(req,"GET",`/remote-chats/${encodeURIComponent(String(req.params.chatId))}`+query);
    if(forwarded)return res.json(forwarded);
    const remote=runtime!.remoteChats(req.query.harnessId);const {native,...conversation}=await remote.snapshot(String(req.params.chatId));
    return res.json({...remote.identity(),conversation:{...conversation,messages:conversation.messages.map(({native,...message})=>message)}});
  }));
  router.patch("/remote-chats/:chatId",route(async(req,res)=>{
    const forwarded=await proxy(req,"PATCH",`/remote-chats/${encodeURIComponent(String(req.params.chatId))}`,req.body);
    if(forwarded)return res.json(forwarded);
    const remote=runtime!.remoteChats(req.body.harnessId);
    if(req.body.connectionId!==remote.identity().connectionId)fail("Remote connection changed",409);
    const {native,...conversation}=await remote.update(String(req.params.chatId),req.body);
    return res.json({...remote.identity(),conversation:{...conversation,messages:conversation.messages.map(({native,...message})=>message)}});
  }));
  router.delete("/remote-chats/:chatId",route(async(req,res)=>{
    const forwarded=await proxy(req,"DELETE",`/remote-chats/${encodeURIComponent(String(req.params.chatId))}`,req.body);
    if(forwarded)return res.json(forwarded);
    const remote=runtime!.remoteChats(req.body.harnessId);
    if(req.body.connectionId!==remote.identity().connectionId)fail("Remote connection changed",409);
    await remote.delete(String(req.params.chatId));return res.json({deleted:true});
  }));
  router.post("/sessions/remote",route(async(req,res)=>res.status(201).json(await proxy(req,"POST","/sessions/remote",req.body)??{session:await runtime!.connectRemoteChat(req.body)})));
  router.get("/projects",route(async(req,res)=>{const harnessId=String(req.query.harnessId??"");return res.json(await proxy(req,"GET",`/projects?harnessId=${encodeURIComponent(harnessId)}`)??runtime!.projects({harnessId,targetId:String(req.query.targetId??"local")}));}));
  router.get("/targets",route((_req,res)=>res.json({targets:runtime!.store.targets()})));
  router.post("/registrations",route(async(req,res)=>{if(req.body.id in ADAPTERS || ["librechat","openwebui"].includes(req.body.id))fail("Built-in adapters cannot be replaced");return res.status(201).json(await proxy(req,"POST","/registrations",req.body)??{harness:runtime!.store.register(req.body)});}));
  router.post("/targets",route((req,res)=>{const v=req.body;const target:HarnessTarget={id:v.id??randomUUID(),name:v.name,kind:v.kind,...(v.sshHost?{sshHost:v.sshHost}:{}),...(v.bridgePath?{bridgePath:v.bridgePath}:{}),...(v.container?{container:v.container}:{})};runtime!.store.saveTarget(target);return res.status(201).json({target});}));
  router.get("/sessions",route(async(req,res)=>res.json(await proxy(req,"GET","/sessions")??{sessions:runtime!.store.sessions().filter(s=>s.targetId===String(req.query.targetId??"local"))})));
  router.post("/sessions",route(async(req,res)=>{const target=remote(req);return res.status(201).json(target?await remotes.request(target,"POST","/sessions",{...req.body,targetId:"local"}):{session:await runtime!.create(req.body)});}));
  router.get("/native-sessions",route(async(req,res)=>res.json(await proxy(req,"GET",`/native-sessions?harnessId=${encodeURIComponent(String(req.query.harnessId??""))}`)??{sessions:discoverNativeSessions(String(req.query.harnessId??"")).map(({file,...v})=>v)})));
  router.get("/native-sessions/:sourceId",route(async(req,res)=>{
    const id=String(req.params.sourceId),harness=String(req.query.harnessId??""),after=Number(req.query.after??0);
    return res.json(await proxy(req,"GET",`/native-sessions/${encodeURIComponent(id)}?harnessId=${encodeURIComponent(harness)}&after=${after}`)??readNativeSession(harness,id,undefined,after));
  }));
  router.post("/sessions/import",route(async(req,res)=>{
    const target=remote(req);if(target)return res.status(201).json(await remotes.request(target,"POST","/sessions/import",{...req.body,targetId:"local"}));
    const source=discoverNativeSessions(req.body.harnessId).find(v=>v.sourceId===req.body.sourceId);
    if(!source || !source.canContinue)fail(source?.reason??"Native session not found or cannot be continued safely",409);
    const session=await runtime!.create({...req.body,nativeSessionId:undefined,workspace:req.body.workspace??source.workspace,title:source.title,authMode:"native"});
    session.configuration={forkNativeSession:true,sourceId:source.sourceId};session.nativeSessionId=source.nativeSessionId;runtime!.store.save(session);
    return res.status(201).json({session,strategy:"isolated_fork"});
  }));
  router.get("/sessions/:id",route(async(req,res)=>res.json(await proxy(req,"GET",`/sessions/${encodeURIComponent(String(req.params.id))}`)??runtime!.snapshot(String(req.params.id)))));
  router.patch("/sessions/:id",route(async(req,res)=>res.json(await proxy(req,"PATCH",`/sessions/${encodeURIComponent(String(req.params.id))}`,req.body)??{session:runtime!.update(String(req.params.id),req.body)})));
  router.delete("/sessions/:id",route(async(req,res)=>{const target=remote(req);if(target)await remotes.request(target,"DELETE",`/sessions/${encodeURIComponent(String(req.params.id))}`);else runtime!.delete(String(req.params.id));return res.json({deleted:true});}));
  router.post("/sessions/:id/commands",route(async(req,res)=>res.json(await proxy(req,"POST",`/sessions/${encodeURIComponent(String(req.params.id))}/commands`,req.body)??{receipt:await runtime!.command(String(req.params.id),req.body)})));
  router.get("/sessions/:id/commands/:commandId",route(async(req,res)=>{
    const target=remote(req);if(target)return res.json(await remotes.request(target,"GET",`/sessions/${encodeURIComponent(String(req.params.id))}/commands/${encodeURIComponent(String(req.params.commandId))}`));
    const receipt=runtime!.store.receipt(String(req.params.commandId));if(!receipt || receipt.sessionId!==String(req.params.id))fail("Operation not found",404);return res.json({receipt});
  }));
  router.post("/sessions/:id/attachments",route(async(req,res)=>res.status(201).json(await proxy(req,"POST",`/sessions/${encodeURIComponent(String(req.params.id))}/attachments`,req.body)??{attachment:runtime!.store.attach(String(req.params.id),req.body.name,req.body.mimeType,req.body.base64,req.body.sha256)})));
  router.get("/sessions/:id/attachments/:attachmentId",route(async(req,res)=>{
    const target=remote(req);if(target)return res.json(await remotes.request(target,"GET",`/sessions/${encodeURIComponent(String(req.params.id))}/attachments/${encodeURIComponent(String(req.params.attachmentId))}`));
    const a=runtime!.store.attachment(String(req.params.id),String(req.params.attachmentId));return res.json({attachment:a.info,base64:a.data.toString("base64")});
  }));
  router.get("/sessions/:id/events",route(async(req,res)=>{
    const id=String(req.params.id);const after=Number(req.query.after??req.headers["last-event-id"]??0);
    if(!Number.isSafeInteger(after) || after<0)fail("Invalid event cursor");
    const target=remote(req);
    if(req.query.poll==="1") {
      if(target)return res.json(await remotes.request(target,"GET",`/sessions/${encodeURIComponent(id)}/events?after=${after}&poll=1&wait=25000`));
      let events=runtime!.store.events(id,after);
      if(!events.length && req.query.wait){await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);off();res.off("close",done);resolve();};const off=runtime!.subscribe(id,done);const timer=setTimeout(done,Math.min(25_000,Number(req.query.wait)||0));res.once("close",done);});events=runtime!.store.events(id,after);}
      return res.json({events,cursor:events.at(-1)?.seq??after});
    }
    // Reading/subscribing never starts work and disconnecting never aborts a turn.
    if(!target)runtime!.session(id);
    res.status(200).set({"content-type":"text/event-stream","x-accel-buffering":"no"});res.flushHeaders();let cursor=after;let closed=false;
    const emit=(event:any)=>{if(closed || event.seq<=cursor)return;if(res.writableLength>2*1024*1024){closed=true;res.end();off();clearInterval(heartbeat);return;}cursor=event.seq;res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);};
    const heartbeat=setInterval(()=>{if(!closed)res.write(": keepalive\n\n");},15_000);heartbeat.unref();
    let off:()=>void=()=>{};res.once("close",()=>{closed=true;off();clearInterval(heartbeat);});
    if(target) {
      while(!closed){const batch=await remotes.request(target,"GET",`/sessions/${encodeURIComponent(id)}/events?after=${cursor}&poll=1&wait=25000`);for(const event of batch.events)emit(event);}
    } else {
      // Subscribe before replay; the cursor deduplicates overlapping records.
      const buffered:any[]=[];let replaying=true;off=runtime!.subscribe(id,event=>{if(replaying)buffered.push(event);else emit(event);});
      for(;;){const batch=runtime!.store.events(id,cursor,500);for(const event of batch)emit(event);if(!batch.length || closed)break;}
      replaying=false;for(const event of buffered)emit(event);
    }
    return undefined;
  }));
  router.get("/sessions/:id/export",route(async(req,res)=>{
    const target=remote(req);if(target)return res.json(await remotes.request(target,"GET",`/sessions/${encodeURIComponent(String(req.params.id))}/export`));
    const id=String(req.params.id),events:any[]=[];let cursor=0,bytes=0;for(;;){const page=runtime!.store.events(id,cursor,500);if(!page.length)break;bytes+=Buffer.byteLength(JSON.stringify(page));if(bytes>24*1024*1024 || events.length+page.length>50_000)fail("Export exceeds its limit; retrieve events using cursor pages",413);events.push(...page);cursor=page.at(-1)!.seq;}
    return res.json({version:1,...runtime!.snapshot(id),interactions:runtime!.store.interactions(id).filter(v=>v.status==="pending"),events});
  }));
  router.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{if(res.headersSent){res.end();return;}res.status(error.status??500).json({error:String(redact(error.status?error.message:"Harness runtime request failed"))});});
  return router;
}
