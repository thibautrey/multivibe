/** Local text-chat adapter for the genuine OpenCode v2 server. No provider impersonation. */
import {createServer} from 'node:http';
import {randomUUID, timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {OpenCodeLocalClient} from './client.mjs';

export const MODEL = 'big-pickle-opencode-local';
export const DEFAULT_MODELS = [{
  id: MODEL,
  upstream: 'big-pickle',
  name: 'Big Pickle · OpenCode local',
  contextWindow: 160000,
  maxOutputTokens: 32000,
  vision: false,
}];

class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function modelSource(models) {
  if (Array.isArray(models)) return async () => models;
  let cache = null;
  let cachedAt = 0;
  let pending = null;
  return async () => {
    if (cache && Date.now() - cachedAt < 300000) return cache;
    if (!pending) {
      pending = Promise.resolve().then(models).then(list => {
        cache = Array.isArray(list) && list.length ? list : DEFAULT_MODELS;
        cachedAt = Date.now();
        return cache;
      }).catch(() => cache ?? DEFAULT_MODELS).finally(() => { pending = null; });
    }
    return pending;
  };
}

export function validateChat(body, models = DEFAULT_MODELS) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('A chat completion request is required');
  const model = models.find(candidate => candidate.id === body.model);
  if (!model) throw new RequestError(`Select ${models.map(candidate => candidate.id).join(', ')}`);
  const accepted = new Set(['model', 'messages', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens']);
  if (Object.keys(body).some(key => !accepted.has(key))) throw new RequestError('OpenCode local supports text conversations only; external tools and sampling overrides are unsupported');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new RequestError('stream must be boolean');
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 256) throw new RequestError('messages required (maximum 256)');
  const messages = body.messages.map(message => {
    if (!message || !['system', 'developer', 'user', 'assistant'].includes(message.role) || Object.keys(message).some(key => !['role', 'content'].includes(key))) throw new RequestError('Only text conversation roles are supported');
    const content = Array.isArray(message.content) ? message.content.map(part => {
      if (part?.type !== 'text' || typeof part.text !== 'string') throw new RequestError('Only text content is supported');
      return part.text;
    }).join('\n') : message.content;
    if (typeof content !== 'string') throw new RequestError('Only text content is supported');
    return {role: message.role, content};
  });
  const maxTokens = body.max_completion_tokens ?? body.max_tokens ?? 4096;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 32000) throw new RequestError('Token limit must be between 1 and 32000');
  return {model, messages, maxTokens};
}

export function createRuntime({apiKey, run, models = DEFAULT_MODELS, maxConcurrent = 2}) {
  if (typeof apiKey !== 'string' || apiKey.length < 24) throw new Error('A local API key of at least 24 characters is required');
  if (typeof run !== 'function' && !Array.isArray(models)) throw new Error('A run function or a model list is required');
  const source = modelSource(models);
  let active = 0;
  return createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${apiKey}`);
    const json = (status, value) => { res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'}); res.end(JSON.stringify(value)); };
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(401, {error: {message: 'Unauthorized'}});
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && pathname === '/v1/models') {
      const list = await source();
      return json(200, {
        object: 'list',
        data: list.map(model => ({
          id: model.id,
          object: 'model',
          owned_by: 'opencode',
          name: model.name,
          supports_tools: false,
          supported_tool_types: [],
          context_window: model.contextWindow,
          max_output_tokens: model.maxOutputTokens,
          capabilities: {tools: false, vision: false},
          metadata: {
            transport: 'official-opencode-server',
            streaming: 'buffered',
            input_modalities: ['text'],
            output_modalities: ['text'],
          },
        })),
      });
    }
    if (req.method !== 'POST' || pathname !== '/v1/chat/completions') return json(404, {error: {message: 'Not found'}});
    if (active >= maxConcurrent) return json(429, {error: {message: 'OpenCode local is busy'}});
    active++;
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', abort);
    try {
      const modelsNow = await source();
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 256 * 1024) throw new RequestError('Conversation exceeds 256 KiB', 413);
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new RequestError('Invalid JSON'); }
      const input = validateChat(body, modelsNow);
      if (typeof run !== 'function') throw new RequestError('No OpenCode runner is configured', 503);
      const result = await run({...input, signal: controller.signal});
      if (controller.signal.aborted) return;
      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const modelID = input.model.id;
      if (!body.stream) {
        return json(200, {
          id,
          object: 'chat.completion',
          created,
          model: modelID,
          choices: [{index: 0, message: {role: 'assistant', content: result.text}, finish_reason: result.finishReason ?? 'stop'}],
          ...(result.usage ? {usage: result.usage} : {}),
        });
      }
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store'});
      const emit = value => res.write(`data: ${JSON.stringify({id, object: 'chat.completion.chunk', created, model: modelID, ...value})}\n\n`);
      emit({choices: [{index: 0, delta: {role: 'assistant', content: result.text}, finish_reason: null}]});
      emit({choices: [{index: 0, delta: {}, finish_reason: result.finishReason ?? 'stop'}]});
      if (body.stream_options?.include_usage && result.usage) emit({choices: [], usage: result.usage});
      res.end('data: [DONE]\n\n');
    } catch (error) {
      if (!controller.signal.aborted) json(error.status ?? 500, {error: {type: 'opencode_local_error', message: error instanceof RequestError ? error.message : error?.message ?? 'OpenCode local request failed'}});
    } finally {
      active--;
      res.off('close', abort);
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const keyFile = process.env.OPENCODE_BRIDGE_KEY_FILE;
  if (!keyFile) {
    console.error('OPENCODE_BRIDGE_KEY_FILE is required');
    process.exit(2);
  }
  const apiKey = (await readFile(keyFile, 'utf8')).trim();
  const port = Number(process.env.OPENCODE_BRIDGE_PORT ?? 14957);
  const timeout = Number(process.env.OPENCODE_BRIDGE_TIMEOUT_MS ?? 120000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    console.error('OPENCODE_BRIDGE_PORT must be a valid TCP port');
    process.exit(2);
  }
  if (!Number.isSafeInteger(timeout) || timeout < 1000) {
    console.error('OPENCODE_BRIDGE_TIMEOUT_MS must be at least 1000');
    process.exit(2);
  }
  const client = new OpenCodeLocalClient({timeoutMs: timeout});
  try {
    await client.start();
  } catch (error) {
    console.error(`OpenCode server failed to start: ${error.message}`);
    await client.close();
    process.exit(1);
  }
  let models = DEFAULT_MODELS;
  try {
    const discovered = await client.listFreeModels();
    if (discovered.length) models = discovered;
    else console.error(`OpenCode reported no free chat models; exposing ${MODEL}`);
  } catch (error) {
    console.error(`OpenCode model discovery failed (${error.message}); exposing ${MODEL}`);
  }
  const server = createRuntime({apiKey, run: input => client.run(input), models});
  server.requestTimeout = timeout + 30000;
  server.listen(port, '127.0.0.1', () => console.log(`OpenCode local listening on 127.0.0.1:${port} (${models.length} model${models.length === 1 ? '' : 's'}: ${models.map(model => model.id).join(', ')})`));
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => server.close(async () => { await client.close(); process.exit(0); }));
  }
}
