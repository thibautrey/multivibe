import fs from 'node:fs';
import {createHash,timingSafeEqual} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

export const INSTANCE_VOICE_ORIGIN='https://app.multivibe.cloud';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const equal=(a:string,b:string)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const uuid=/^[0-9a-f-]{36}$/i;
export const SPEECH_MODELS={kokoro:'Kokoro-82M-bf16',qwen:'Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16',stt:'whisper-large-v3-turbo-asr-4bit'};
export type InstanceVoiceOptions={stateFile:string;edgeOrigin:string;edgeKey:string;speechOrigin:string;llmModel:string;relayOrigin?:string};
type Live={socket:WebSocket;deviceId:string;deviceToken:string;voice:string;credit:boolean;exhausted:boolean;speaking:boolean;manualCommit:boolean;closed:boolean;timer:NodeJS.Timeout;pending:string[];pendingBytes:number};

/** Read the Host's current authorization file for every check. This companion
 * cannot pair devices, rotate credentials, poll jobs or change the main Host. */
export function authorizeVoiceDevice(file:string,deviceId:unknown,token:unknown,now=Date.now()) {
  const state=JSON.parse(fs.readFileSync(file,'utf8'));
  const device=state.devices?.find((d:any)=>d.id===deviceId),hash=digest(typeof token==='string'?token:'');
  if(state.version!==1||!uuid.test(state.machineId)||!device||device.expiresAt<=now
    ||!(equal(device.digest,hash)||device.previous?.expiresAt>now&&equal(device.previous.digest,hash)))throw Error('Device authorization expired or revoked');
  return state;
}
export function loopbackOrigin(value:string) {
  const url=new URL(value);
  if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('Voice adapters require a loopback origin');
  return url.origin;
}

export class InstanceVoiceBridge {
  private control?:WebSocket;
  private sessions=new Map<string,Live>();
  private stopped=false;
  private voices=new Map<string,{model:string;voice:string;name:string}>();
  private readonly edge:string;
  private readonly speech:string;
  private readonly origin:string;
  constructor(private readonly options:InstanceVoiceOptions){
    this.edge=loopbackOrigin(options.edgeOrigin);this.speech=loopbackOrigin(options.speechOrigin);
    this.origin=options.relayOrigin??INSTANCE_VOICE_ORIGIN;
    if(this.origin!==INSTANCE_VOICE_ORIGIN&&!(process.env.NODE_ENV==='test'&&new URL(this.origin).hostname==='127.0.0.1'))throw Error('Use the fixed MultiVibe Relay origin');
  }
  async capabilities(){
    const response=await fetch(this.speech+'/v1/models',{redirect:'error',signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw Error('Speech runtime unavailable');
    const models=await response.json() as {data:{id:string}[]},loaded=new Set(models.data.map(m=>m.id));
    if(!loaded.has(SPEECH_MODELS.stt))throw Error('Transcription model unavailable');
    this.voices.clear();
    for(const [provider,label] of [['kokoro','Kokoro'],['qwen','Qwen3 TTS']] as const){
      const model=SPEECH_MODELS[provider];if(!loaded.has(model))continue;
      const result=await fetch(this.speech+'/v1/audio/voices?model='+encodeURIComponent(model),{redirect:'error',signal:AbortSignal.timeout(5000)});
      if(!result.ok)continue;const body=await result.json() as {voices:string[]};
      for(const voice of body.voices){if(!/^[A-Za-z0-9_-]{1,80}$/.test(voice))continue;this.voices.set(provider+':'+voice,{model,voice,name:label+' · '+voice});}
    }
    const voices=[...this.voices].map(([id,v])=>({id,name:v.name}));
    voices.sort((a,b)=>a.id==='kokoro:ff_siwis'?-1:b.id==='kokoro:ff_siwis'?1:a.name.localeCompare(b.name));
    return {enabled:voices.length>0,voices,backgroundAudio:false,tools:false,retainsAudio:false,llmModel:this.options.llmModel,transcriptionModel:SPEECH_MODELS.stt};
  }
  speechVoice(id:unknown){const voice=typeof id==='string'?this.voices.get(id):undefined;if(!voice)throw Error('Voice unavailable');return voice;}
  private send(body:unknown){
    if(!this.control||this.control.readyState!==WebSocket.OPEN||this.control.bufferedAmount>2*1024*1024)throw Error('Voice Relay disconnected');
    this.control.send(JSON.stringify(body));
  }
  private close(id:string,notify=true){
    const live=this.sessions.get(id);if(!live||live.closed)return;live.closed=true;clearInterval(live.timer);live.socket.close();this.sessions.delete(id);
    if(notify)try{this.send({type:'close',sessionId:id});}catch{}
  }
  private turn(id:string,live:Live){
    if(!live.credit)throw Error('Relay allowance unavailable');live.credit=false;this.send({type:'turn.started',sessionId:id});
  }
  private upstream(live:Live,event:any){
    const text=JSON.stringify(event);if(text.length>256*1024)throw Error('Voice frame too large');
    if(live.socket.readyState===WebSocket.OPEN){if(live.socket.bufferedAmount>1024*1024)throw Error('Voice input backpressure');live.socket.send(text);}
    else{live.pendingBytes+=Buffer.byteLength(text);if(live.pendingBytes>256*1024)throw Error('Voice input backpressure');live.pending.push(text);}
  }
  private async open(packet:any){
    const id=packet.sessionId;
    if(!uuid.test(id)||this.sessions.has(id)||this.sessions.size>=4)throw Error('Voice session unavailable');
    authorizeVoiceDevice(this.options.stateFile,packet.deviceId,packet.deviceToken);
    await this.capabilities();this.speechVoice(packet.voice);
    const response=await fetch(this.edge+'/v1/realtime/client_secrets',{method:'POST',redirect:'error',headers:{authorization:'Bearer '+this.options.edgeKey,'content-type':'application/json'},body:JSON.stringify({session:{type:'realtime',model:'multivibe/voice'}}),signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw Error('Voice edge unavailable');
    const secret=await response.json() as {value?:string;client_secret?:{value:string}};
    const token=secret.value??secret.client_secret?.value;if(!token)throw Error('Voice edge credential unavailable');
    // This one-time credential stays on loopback. It is never sent to iOS.
    const endpoint=new URL(this.edge.replace('http:','ws:')+'/v1/realtime');endpoint.searchParams.set('model','multivibe/voice');endpoint.searchParams.set('client_secret',token);
    const socket=new WebSocket(endpoint),live:Live={socket,deviceId:packet.deviceId,deviceToken:packet.deviceToken,voice:packet.voice,credit:true,exhausted:false,speaking:false,manualCommit:false,closed:false,pending:[],pendingBytes:0,
      timer:setInterval(()=>{try{authorizeVoiceDevice(this.options.stateFile,packet.deviceId,packet.deviceToken);}catch{this.close(id);}},3000)};
    this.sessions.set(id,live);live.timer.unref();
    socket.addEventListener('open',()=>{try{
      for(const event of live.pending)socket.send(event);live.pending=[];live.pendingBytes=0;
      this.send({type:'opened',sessionId:id});
    }catch{this.close(id);}});
    socket.addEventListener('message',event=>{try{
      if(typeof event.data!=='string'||event.data.length>2*1024*1024)throw Error();const value=JSON.parse(event.data);
      if(value.type==='input_audio_buffer.speech_started'){this.turn(id,live);live.speaking=true;}
      if(value.type==='input_audio_buffer.speech_stopped'){
        live.speaking=false;
        if(live.exhausted)this.send({type:'event',sessionId:id,event:{type:'multivibe.voice.input_disabled'}});
      }
      this.send({type:'event',sessionId:id,event:value});
    }catch{this.close(id);}});
    socket.addEventListener('close',()=>this.close(id));socket.addEventListener('error',()=>this.close(id));
  }
  private async packet(packet:any){
    if(packet.type==='authenticated')return;
    if(packet.type==='capabilities'){
      try{authorizeVoiceDevice(this.options.stateFile,packet.deviceId,packet.deviceToken);this.send({requestId:packet.requestId,capabilities:await this.capabilities()});}
      catch{this.send({requestId:packet.requestId,error:'remote_voice_unavailable'});}return;
    }
    if(packet.type==='open'){try{await this.open(packet);}catch{this.send({type:'close',sessionId:packet.sessionId});}return;}
    const live=this.sessions.get(packet.sessionId);if(!live||live.closed)return;
    if(packet.type==='close'){this.close(packet.sessionId,false);return;}
    if(packet.type==='credit'){live.credit=true;return;}
    if(packet.type==='no_credit'){
      live.credit=false;live.exhausted=true;
      if(!live.speaking)this.send({type:'event',sessionId:packet.sessionId,event:{type:'multivibe.voice.input_disabled'}});return;
    }
    if(packet.type!=='event')throw Error('Unknown Relay event');
    const event=packet.event;
    const allowed=new Set(['session.update','conversation.item.create','conversation.item.delete','conversation.item.truncate','input_audio_buffer.append','input_audio_buffer.clear','input_audio_buffer.commit','response.create','response.cancel']);
    if(!event||!allowed.has(event.type))throw Error('Unsupported voice event');
    if(event.type==='input_audio_buffer.append'&&!live.speaking&&!live.credit)return;
    if(event.type==='input_audio_buffer.commit'){
      if(!live.speaking)this.turn(packet.sessionId,live);live.speaking=false;live.manualCommit=true;
    }
    if(event.type==='response.create'){
      if(!live.manualCommit)this.turn(packet.sessionId,live);live.manualCommit=false;
    }
    if(event.type==='session.update'){
      if(!event.session||typeof event.session!=='object')throw Error('Invalid voice session');
      event.session.tools=[];event.session.instructions='Réponds en français, naturellement et brièvement pour une conversation vocale. Tu es MultiVibe.';
      event.session.audio={...event.session.audio,output:{...event.session.audio?.output,voice:live.voice}};
    }
    this.upstream(live,event);
  }
  async run(){
    while(!this.stopped){
      try{
        const state=JSON.parse(fs.readFileSync(this.options.stateFile,'utf8'));
        if(state.version!==1||!uuid.test(state.machineId)||!/^mvr_[A-Za-z0-9_-]{43}$/.test(state.machineToken))throw Error('Instance unavailable');
        await this.capabilities();
        const socket=new WebSocket(this.origin.replace('https:','wss:').replace('http:','ws:')+'/relay/voice/v1/machine/'+state.machineId);this.control=socket;
        await new Promise<void>(resolve=>{
          socket.addEventListener('open',()=>socket.send(JSON.stringify({type:'authenticate',token:state.machineToken})));
          socket.addEventListener('message',event=>{void(async()=>{
            if(typeof event.data!=='string'||event.data.length>2*1024*1024)throw Error();await this.packet(JSON.parse(event.data));
          })().catch(()=>socket.close());});
          // Undici already fails the connection on error. Calling close while
          // its handshake is failing can synchronously dispatch another error.
          socket.addEventListener('error',()=>resolve());socket.addEventListener('close',()=>resolve());
        });
      }catch{}
      for(const id of this.sessions.keys())this.close(id,false);
      this.control=undefined;if(!this.stopped)await delay(3000);
    }
  }
  stop(){this.stopped=true;this.control?.close();for(const id of this.sessions.keys())this.close(id,false);}
}
