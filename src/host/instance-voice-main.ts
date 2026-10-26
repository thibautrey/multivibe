import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {InstanceVoiceBridge,loopbackOrigin,SPEECH_MODELS} from './instance-voice.js';

// A separately supervised companion: starting or stopping it never signals the
// main Host, its harnesses, or the independently managed speech runtime.
const data=process.env.MULTIVIBE_HOST_DATA_DIR??path.join(os.homedir(),'Library/Application Support/MultiVibe');
const config=JSON.parse(fs.readFileSync(path.join(data,'instance-voice.json'),'utf8')) as {
  llm:{model:string;baseUrl:string;apiKeyEnvironmentFile:string;apiKeyName:string};speechOrigin?:string;edgeBinary?:string;edgePort?:number;
};
if(!config.llm?.model||!config.llm.baseUrl||!config.llm.apiKeyEnvironmentFile||!/^\w+$/.test(config.llm.apiKeyName))throw Error('Explicit instance voice model configuration required');
const source=fs.readFileSync(config.llm.apiKeyEnvironmentFile,'utf8');
const raw=source.split(/\r?\n/).find(line=>line.startsWith(config.llm.apiKeyName+'='))?.slice(config.llm.apiKeyName.length+1).trim();
const apiKey=raw?.replace(/^(["'])(.*)\1$/,'$2');if(!apiKey)throw Error('Voice language-model credential unavailable');
const runtime=path.join(data,'instance-voice-runtime');fs.mkdirSync(runtime,{recursive:true,mode:0o700});
const key=randomBytes(32).toString('base64url'),speech=loopbackOrigin(config.speechOrigin??'http://127.0.0.1:8000');
const store=path.join(runtime,'accounts.json');
fs.writeFileSync(store,JSON.stringify({accounts:[{id:'instance-voice-llm',provider:'openai-compatible',upstreamMode:'chat/completions',accessToken:apiKey,baseUrl:config.llm.baseUrl,enabled:true,sdkModels:[config.llm.model]}]}),{mode:0o600});
fs.chmodSync(store,0o600);
let bridge:InstanceVoiceBridge|undefined;
const tts=http.createServer(async(request,response)=>{
  try{
    if(request.method!=='POST'||request.url!=='/speech'||request.headers.authorization!=='Bearer '+key)throw Error();
    const chunks:Buffer[]=[];let bytes=0;
    for await(const chunk of request){bytes+=chunk.length;if(bytes>128*1024)throw Error();chunks.push(Buffer.from(chunk));}
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const selected=bridge?.speechVoice(body.voice);if(!selected||typeof body.input!=='string'||body.input.length>32_000)throw Error();
    const upstream=await fetch(speech+'/v1/audio/speech',{method:'POST',redirect:'error',headers:{'content-type':'application/json'},
      body:JSON.stringify({model:selected.model,voice:selected.voice,input:body.input,response_format:'pcm',stream:true}),signal:AbortSignal.timeout(120_000)});
    if(!upstream.ok||!upstream.body){response.writeHead(502);response.end();return;}
    response.writeHead(200,{'content-type':'application/octet-stream'});
    const reader=upstream.body.getReader();response.once('close',()=>{void reader.cancel().catch(()=>{});});
    for(;;){const {done,value}=await reader.read();if(done||response.destroyed)break;response.write(value);}
    response.end();
  }catch{if(!response.headersSent)response.writeHead(400);response.end();}
});
await new Promise<void>(resolve=>tts.listen(0,'127.0.0.1',resolve));
const address=tts.address();if(!address||typeof address==='string')throw Error('Voice adapter unavailable');
const port=config.edgePort??1457;if(!Number.isSafeInteger(port)||port<1024||port>65535)throw Error('Invalid voice edge port');
const edge=spawn(config.edgeBinary??'/Applications/MultiVibe Host.app/Contents/Helpers/multivibe-v1-edge',[],{stdio:['ignore','pipe','pipe'],env:{...process.env,
  V1_EDGE_HOST:'127.0.0.1',V1_EDGE_PORT:String(port),STORE_PATH:store,V1_EDGE_STORE_PATH:store,PROXY_API_KEY:key,PROXY_API_KEYS:'',PROXY_MODELS:config.llm.model,
  V1_EDGE_JOBS_PATH:path.join(runtime,'jobs.json'),JOBS_DB_PATH:path.join(runtime,'legacy-jobs.sqlite'),V1_EDGE_MODELS_CACHE_PATH:path.join(runtime,'models.json'),
  TRACE_FILE_PATH:path.join(runtime,'trace.jsonl'),TRACE_INCLUDE_BODY:'false',V1_EDGE_TRACE_INCLUDE_BODY:'false',
  REALTIME_CASCADE_ENABLED:'true',REALTIME_CASCADE_MODEL:'multivibe/voice',REALTIME_CASCADE_LLM_MODEL:config.llm.model,
  REALTIME_STT_URL:speech+'/v1/audio/transcriptions',REALTIME_STT_MODEL:SPEECH_MODELS.stt,
  REALTIME_TTS_URL:'http://127.0.0.1:'+address.port+'/speech',REALTIME_TTS_API_KEY:key,REALTIME_TTS_MODEL:SPEECH_MODELS.kokoro,REALTIME_TTS_VOICE:'kokoro:ff_siwis',REALTIME_TTS_RESPONSE_FORMAT:'pcm',
}});
// Edge diagnostics can contain request URLs. Keep them in a private local file.
const log=fs.createWriteStream(path.join(runtime,'edge.log'),{flags:'a',mode:0o600});edge.stdout.pipe(log);edge.stderr.pipe(log);
let ended=false;
const stop=()=>{if(ended)return;ended=true;bridge?.stop();edge.kill('SIGTERM');tts.close();};
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,stop);
edge.once('exit',()=>{stop();process.exitCode=1;});
try{
  const origin='http://127.0.0.1:'+port;
  let ready=false;
  for(let attempt=0;attempt<50&&!ended;attempt++){
    try{const response=await fetch(origin+'/health',{signal:AbortSignal.timeout(500)});if(response.ok){ready=true;break;}}catch{}
    await delay(100);
  }
  if(!ready)throw Error('Voice edge did not start');
  bridge=new InstanceVoiceBridge({stateFile:path.join(data,'instance-relay-v1.json'),edgeOrigin:origin,edgeKey:key,speechOrigin:speech,llmModel:config.llm.model});
  await bridge.run();
}finally{stop();}
