/** Local text-chat adapter for the genuine OpenCode CLI. No provider impersonation. */
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID, timingSafeEqual} from 'node:crypto';
import {mkdtemp, mkdir, rm, readFile} from 'node:fs/promises';
import {tmpdir, homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {StringDecoder} from 'node:string_decoder';

export const MODEL = 'opencode/big-pickle';
class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function validateChat(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.model !== MODEL) throw new RequestError(`Select ${MODEL}`);
  const accepted = new Set(['model','messages','stream','stream_options','max_tokens','max_completion_tokens']);
  if (Object.keys(body).some(k => !accepted.has(k))) throw new RequestError('OpenCode local supports text conversations only; external tools and sampling overrides are unsupported');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new RequestError('stream must be boolean');
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 256) throw new RequestError('messages required (maximum 256)');
  const messages = body.messages.map(m => {
    if (!m || !['system','developer','user','assistant'].includes(m.role) || Object.keys(m).some(k => !['role','content'].includes(k))) throw new RequestError('Only text conversation roles are supported');
    const content = Array.isArray(m.content) ? m.content.map(p => {
      if (p?.type !== 'text' || typeof p.text !== 'string') throw new RequestError('Only text content is supported');
      return p.text;
    }).join('\n') : m.content;
    if (typeof content !== 'string') throw new RequestError('Only text content is supported');
    return {role:m.role,content};
  });
  const maxTokens = body.max_completion_tokens ?? body.max_tokens ?? 4096;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 32000) throw new RequestError('Token limit must be between 1 and 32000');
  return {messages,maxTokens};
}
export async function runOpenCode({messages,maxTokens,signal}, options = {}) {
  const binary = options.binary ?? process.env.OPENCODE_BIN ?? path.join(homedir(),'.opencode/bin/opencode');
  const workspace = await mkdtemp(path.join(options.tempRoot ?? tmpdir(),'multivibe-opencode-'));
  try {
    await mkdir(path.join(workspace,'project'));
    const config = {permission:'ask',share:'disabled',plugin:[],mcp:{},autoupdate:false,
      provider:{opencode:{models:{'big-pickle':{limit:{context:200000,output:maxTokens}}}}}};
    // Explicit environment prevents importing unrelated provider keys, plugins,
    // project instructions, MCP servers, and the user's global OpenCode settings.
    const env = {PATH:process.env.PATH,HOME:homedir(),TMPDIR:tmpdir(),LANG:'en_US.UTF-8',
      XDG_CONFIG_HOME:path.join(workspace,'config'),XDG_DATA_HOME:path.join(workspace,'data'),
      XDG_STATE_HOME:path.join(workspace,'state'),XDG_CACHE_HOME:options.cacheDir ?? path.join(homedir(),'.cache/multivibe-opencode'),
      OPENCODE_CONFIG_CONTENT:JSON.stringify(config),OPENCODE_DISABLE_AUTOUPDATE:'true'};
    const prompt = 'Answer the final user message in this text conversation. Preserve the supplied conversation context and instructions. Do not use tools or inspect files. Return only the answer.\n\n' + JSON.stringify(messages);
    return await new Promise((resolve,reject) => {
      const child = spawn(binary,['run','--pure','--model',MODEL,'--format','json','--title','MultiVibe text conversation'],{cwd:path.join(workspace,'project'),env,stdio:['pipe','pipe','pipe']});
      let buffer='',text='',usage,sessionID,bytes=0,failure,killTimer,finishReason='stop';
      const decoder=new StringDecoder('utf8');
      const fail = error => {failure ??= error;child.kill('SIGTERM');killTimer ??= setTimeout(()=>child.kill('SIGKILL'),3000);};
      const timeout = setTimeout(() => fail(new RequestError('OpenCode request timed out',504)),options.timeoutMs ?? 120000);
      const abort = () => fail(new RequestError('Request cancelled',499));
      signal?.addEventListener('abort',abort,{once:true});
      if (signal?.aborted) abort();
      const consume = line => {
        if (!line.trim()) return;
        let event;try {event=JSON.parse(line);} catch {return;}
        sessionID ??= event.sessionID;
        if (event.type==='error') {
          const status=event.error?.data?.statusCode ?? event.error?.status;
          fail(new RequestError(status===429?'OpenCode rate limit reached':'OpenCode request failed',status===429?429:502));
        }
        if (event.type==='tool_use') fail(new RequestError('OpenCode requested a tool; local text mode does not execute tools',422));
        if (event.type==='text') text += event.part?.text ?? '';
        if (event.type==='step_finish' && event.part?.reason==='length') finishReason='length';
        if (event.type==='step_finish' && event.part?.tokens) {
          const t=event.part.tokens;
          const input=(t.input ?? 0)+(t.cache?.read ?? 0)+(t.cache?.write ?? 0);
          const output=(t.output ?? 0)+(t.reasoning ?? 0);
          usage={prompt_tokens:input,completion_tokens:output,total_tokens:input+output};
        }
      };
      child.stdout.on('data',chunk => {
        bytes+=chunk.length;if(bytes>4*1024*1024){fail(new RequestError('OpenCode output limit exceeded',502));return;}
        buffer+=decoder.write(chunk);let index;
        while((index=buffer.indexOf('\n'))>=0){consume(buffer.slice(0,index));buffer=buffer.slice(index+1);}
      });
      child.stderr.on('data',chunk => {bytes+=chunk.length;if(bytes>4*1024*1024)fail(new RequestError('OpenCode output limit exceeded',502));});
      child.stdin.on('error',()=>{});
      child.once('error',()=>{failure=new RequestError('OpenCode CLI unavailable; install OpenCode v1.18 or newer v1',503);});
      child.once('close',code => {
        clearTimeout(timeout);clearTimeout(killTimer);buffer+=decoder.end();signal?.removeEventListener('abort',abort);consume(buffer);
        if(failure)return reject(failure);
        if(code!==0 || !text.trim())return reject(new RequestError('OpenCode returned no answer',502));
        resolve({text,usage,sessionID,finishReason});
      });
      child.stdin.end(prompt);
    });
  } finally {await rm(workspace,{recursive:true,force:true});}
}
export function createRuntime({apiKey,run=runOpenCode,maxConcurrent=2}) {
  if (typeof apiKey!=='string' || apiKey.length<24) throw new Error('A local API key of at least 24 characters is required');
  let active=0;
  return createServer(async(req,res) => {
    const supplied=Buffer.from(req.headers.authorization ?? ''),expected=Buffer.from(`Bearer ${apiKey}`);
    const json=(status,value) => {res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
    if(supplied.length!==expected.length || !timingSafeEqual(supplied,expected))return json(401,{error:{message:'Unauthorized'}});
    if(req.method==='GET' && req.url==='/v1/models')return json(200,{object:'list',data:[{id:MODEL,object:'model',owned_by:'opencode',name:'Big Pickle · OpenCode local',capabilities:{tools:false,vision:false},metadata:{transport:'official-opencode-cli',streaming:'buffered',input_modalities:['text'],output_modalities:['text']}}]});
    if(req.method!=='POST' || req.url!=='/v1/chat/completions')return json(404,{error:{message:'Not found'}});
    if(active>=maxConcurrent)return json(429,{error:{message:'OpenCode local is busy'}});
    active++;
    const controller=new AbortController();const abort=()=>{if(!res.writableEnded)controller.abort();};res.once('close',abort);
    try {
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>256*1024)throw new RequestError('Conversation exceeds 256 KiB',413);chunks.push(chunk);}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{throw new RequestError('Invalid JSON');}
      const input=validateChat(body);
      const result=await run({...input,signal:controller.signal});
      if(controller.signal.aborted)return;
      const id=`chatcmpl-${randomUUID()}`,created=Math.floor(Date.now()/1000);
      if(!body.stream)return json(200,{id,object:'chat.completion',created,model:MODEL,choices:[{index:0,message:{role:'assistant',content:result.text},finish_reason:result.finishReason??'stop'}],...(result.usage?{usage:result.usage}:{})});
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});
      const emit=value=>res.write(`data: ${JSON.stringify({id,object:'chat.completion.chunk',created,model:MODEL,...value})}\n\n`);
      emit({choices:[{index:0,delta:{role:'assistant',content:result.text},finish_reason:null}]});
      emit({choices:[{index:0,delta:{},finish_reason:result.finishReason??'stop'}]});
      if(body.stream_options?.include_usage && result.usage)emit({choices:[],usage:result.usage});
      res.end('data: [DONE]\n\n');
    }catch(error){if(!controller.signal.aborted)json(error.status??500,{error:{type:'opencode_local_error',message:error instanceof RequestError?error.message:'OpenCode local request failed'}});}
    finally{active--;res.off('close',abort);}
  });
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const apiKey=(await readFile(process.env.OPENCODE_BRIDGE_KEY_FILE,'utf8')).trim();
  const port=Number(process.env.OPENCODE_BRIDGE_PORT ?? 14957);
  const server=createRuntime({apiKey});server.requestTimeout=150000;
  server.listen(port,'127.0.0.1',()=>console.log(`OpenCode local listening on 127.0.0.1:${port}`));
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>process.exit(0)));
}
