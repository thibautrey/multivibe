/**
 * Client for the genuine OpenCode v2 server. No provider impersonation.
 *
 * The free tier only accepts agent-session traffic produced by the official
 * client. Raw generation (`/api/experimental/generate/text`) and direct Zen
 * requests are rejected with `429 FreeUsageLimitError`, even from this server,
 * so this client drives a real session: create -> prompt -> messages.
 */
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import path from 'node:path';

export const AUTH_USER = 'opencode';
const SESSION_PATH = '/api/session';
const POLL_INTERVAL_MS = 250;
const MAX_OUTPUT_TOKENS = 32000;

export class OpenCodeLocalError extends Error {
  constructor(message, status = 502, details = {}) {
    super(message);
    this.name = 'OpenCodeLocalError';
    this.status = status;
    for (const [key, value] of Object.entries(details)) if (value !== undefined) this[key] = value;
  }
}

export function catalogID(upstream) {
  return `${upstream}-opencode-local`;
}

export function isFreeChatModel(model) {
  if (!model || model.type !== 'chat') return false;
  const output = model.capabilities?.output;
  if (Array.isArray(output) && !output.includes('text')) return false;
  const costs = Array.isArray(model.cost) ? model.cost : model.cost ? [model.cost] : [];
  return costs.length > 0 && costs.every(cost => cost && cost.input === 0 && cost.output === 0);
}

export function catalogEntry(model) {
  const limit = model.limit ?? {};
  const context = Number.isSafeInteger(limit.context) && limit.context > 0 ? limit.context : 200000;
  const output = Number.isSafeInteger(limit.output) && limit.output > 0 ? limit.output : MAX_OUTPUT_TOKENS;
  return {
    id: catalogID(model.id),
    upstream: model.id,
    name: `${model.name ?? model.id} · OpenCode local`,
    contextWindow: context,
    // The adapter is text-only: images and client tools are rejected, so it
    // never advertises vision even when the upstream model accepts images.
    maxOutputTokens: Math.min(output, MAX_OUTPUT_TOKENS),
    vision: false,
  };
}

export function mapSessionError(error, fallback = 'OpenCode request failed') {
  const freeLimit = error?.status === 429 || error?.type === 'provider.free-limit';
  const detail = error?.message ? `: ${error.message}` : '';
  return new OpenCodeLocalError(
    freeLimit ? `OpenCode free tier rejected this request (${error?.type ?? 'free limit'})${detail}` : `${fallback}${detail}`,
    freeLimit ? 429 : 502,
    {upstreamType: error?.type, retryAfterMs: error?.retryAfterMs},
  );
}

function buildPrompt(messages) {
  return 'Answer the final user message in this text conversation. Preserve the supplied conversation context and instructions. Do not use tools or inspect files. Return only the answer.\n\n'
    + JSON.stringify(messages);
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new OpenCodeLocalError('Request cancelled', 499));
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(new OpenCodeLocalError('Request cancelled', 499)); };
    signal?.addEventListener('abort', abort, {once: true});
  });
}

export class OpenCodeLocalClient {
  constructor(options = {}) {
    this.binary = options.binary ?? process.env.OPENCODE_BIN ?? path.join(homedir(), '.opencode/bin/opencode');
    this.serverUrl = options.serverUrl ?? process.env.OPENCODE_SERVER_URL;
    this.password = options.password ?? process.env.OPENCODE_SERVER_PASSWORD;
    this.port = options.port ?? 0;
    this.workspace = options.workspace ?? process.env.OPENCODE_BRIDGE_WORKSPACE;
    this.cacheDir = options.cacheDir ?? path.join(homedir(), '.cache/multivibe-opencode');
    this.timeoutMs = options.timeoutMs ?? 120000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 20000;
    this.tempRoot = options.tempRoot ?? tmpdir();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.modelFilter = options.models ?? parseModelFilter(process.env.OPENCODE_BRIDGE_MODELS);
    this.root = null;
    this.baseUrl = null;
    this.child = null;
  }

  async start() {
    if (this.serverUrl) {
      if (!this.password) throw new OpenCodeLocalError('OPENCODE_SERVER_PASSWORD is required with OPENCODE_SERVER_URL', 400);
      this.baseUrl = this.serverUrl.replace(/\/+$/, '');
      if (!this.workspace) this.workspace = path.join(await this.createRoot(), 'project');
      await mkdir(this.workspace, {recursive: true});
      return this;
    }
    await this.createRoot();
    this.workspace ??= path.join(this.root, 'project');
    await mkdir(this.workspace, {recursive: true});
    await mkdir(this.cacheDir, {recursive: true});
    try {
      await this.startServer();
    } catch (error) {
      await this.close();
      throw error;
    }
    return this;
  }

  async createRoot() {
    this.root = await mkdtemp(path.join(this.tempRoot, 'multivibe-opencode-'));
    return this.root;
  }

  async startServer() {
    await mkdir(path.join(this.root, 'config'), {recursive: true});
    await mkdir(path.join(this.root, 'state'), {recursive: true});
    const env = {
      PATH: process.env.PATH,
      HOME: homedir(),
      TMPDIR: tmpdir(),
      LANG: 'en_US.UTF-8',
      XDG_CONFIG_HOME: path.join(this.root, 'config'),
      XDG_STATE_HOME: path.join(this.root, 'state'),
      XDG_CACHE_HOME: this.cacheDir,
      // No plugins, MCP servers, project instructions or sharing. Permission
      // stays "ask": removing tools from the request triggers the free-tier
      // rejection, so tools remain declared and are never auto-approved.
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: 'ask',
        share: 'disabled',
        plugin: [],
        mcp: {},
        autoupdate: false,
      }),
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
    };
    const child = this.spawnImpl(
      this.binary,
      ['serve', '--hostname', '127.0.0.1', '--port', String(this.port)],
      {cwd: this.workspace, env, stdio: ['ignore', 'pipe', 'pipe']},
    );
    this.child = child;
    const ready = new Promise((resolve, reject) => {
      let out = '';
      let err = '';
      let settled = false;
      let timer;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      timer = setTimeout(() => finish(new OpenCodeLocalError('OpenCode server did not start in time', 503)), this.startupTimeoutMs);
      child.stdout.on('data', chunk => {
        out += chunk.toString();
        let index;
        while ((index = out.indexOf('\n')) >= 0) {
          const line = out.slice(0, index);
          out = out.slice(index + 1);
          const listening = /server listening on (https?:\/\/\S+)/.exec(line);
          if (listening) this.baseUrl = listening[1].replace(/\/+$/, '');
          const password = /server password (\S+)/.exec(line);
          if (password) this.password = password[1];
          if (this.baseUrl && this.password) finish();
        }
      });
      child.stderr.on('data', chunk => { err = (err + chunk.toString()).slice(-500); });
      child.once('error', () => finish(new OpenCodeLocalError('OpenCode CLI unavailable; install OpenCode v2.4 or newer', 503)));
      child.once('exit', code => {
        if (!settled) finish(new OpenCodeLocalError(`OpenCode server exited before becoming ready (code ${code})${err ? `: ${err.trim()}` : ''}`, 503));
      });
    });
    try {
      await ready;
    } catch (error) {
      await this.killChild();
      throw error;
    }
  }

  async request(method, pathname, {body, signal, timeoutMs} = {}) {
    if (!this.baseUrl) throw new OpenCodeLocalError('OpenCode server is not running', 503);
    const url = `${this.baseUrl}${pathname}`;
    const headers = {
      authorization: `Basic ${Buffer.from(`${AUTH_USER}:${this.password}`).toString('base64')}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const signals = [];
    if (signal) signals.push(signal);
    if (timeoutMs) signals.push(AbortSignal.timeout(timeoutMs));
    const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combined,
      });
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw new OpenCodeLocalError('Request cancelled', 499);
      throw new OpenCodeLocalError('OpenCode server is unreachable', 503);
    }
    const text = await response.text();
    let value;
    if (text) {
      try { value = JSON.parse(text); } catch { value = undefined; }
    }
    if (!response.ok) {
      const upstream = value?.error ?? value;
      const status = response.status === 429 || upstream?.type === 'provider.free-limit'
        ? 429
        : response.status >= 400 && response.status < 500 ? response.status : 502;
      throw new OpenCodeLocalError(upstream?.message ?? `OpenCode server returned ${response.status}`, status, {
        upstreamType: upstream?.type,
        retryAfterMs: upstream?.retryAfterMs,
      });
    }
    return value;
  }

  async listFreeModels() {
    const query = new URLSearchParams({'location[directory]': this.workspace});
    const wanted = this.modelFilter ? new Set(this.modelFilter) : null;
    let models = [];
    // A brand-new workspace answers the first catalog query with an empty list
    // while its project is being registered; retry briefly before concluding
    // that no free model is available.
    for (let attempt = 0; attempt < 3 && models.length === 0; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 300));
      const payload = await this.request('GET', `/api/model?${query}`, {timeoutMs: 15000});
      const list = payload?.data ?? payload ?? [];
      if (!Array.isArray(list)) throw new OpenCodeLocalError('OpenCode returned an invalid model catalog', 502);
      models = list;
    }
    return models
      .filter(model => isFreeChatModel(model))
      .filter(model => !wanted || wanted.has(model.id))
      .filter(model => model?.type === 'chat')
      .map(catalogEntry)
      .filter((entry, index, list) => list.findIndex(candidate => candidate.id === entry.id) === index)
      .sort((a, b) => (a.upstream === 'big-pickle' ? -1 : b.upstream === 'big-pickle' ? 1 : a.id.localeCompare(b.id)));
  }

  async run({model, messages, maxTokens, signal}, options = {}) {
    if (!this.baseUrl) throw new OpenCodeLocalError('OpenCode server is not running', 503);
    if (!model?.upstream) throw new OpenCodeLocalError('Unknown OpenCode model', 400);
    const limit = maxTokens ?? 4096;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_OUTPUT_TOKENS) {
      throw new OpenCodeLocalError(`Token limit must be between 1 and ${MAX_OUTPUT_TOKENS}`, 400);
    }
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const forwardAbort = () => controller.abort();
    signal?.addEventListener('abort', forwardAbort, {once: true});
    if (signal?.aborted) controller.abort();
    let sessionID;
    try {
      const created = await this.request('POST', SESSION_PATH, {
        body: {
          model: {providerID: 'opencode', id: model.upstream},
          location: {directory: this.workspace},
          // Tools must stay declared: removing them triggers the free-tier
          // rejection. "ask" keeps them in the request but never lets the
          // session execute one unattended.
          permissions: [{action: '*', resource: '*', effect: 'ask'}],
          title: 'MultiVibe text conversation',
        },
        signal: controller.signal,
        timeoutMs: 30000,
      });
      sessionID = created?.data?.id ?? created?.id;
      if (!sessionID) throw new OpenCodeLocalError('OpenCode did not create a session', 502);
      await this.request('POST', `${SESSION_PATH}/${encodeURIComponent(sessionID)}/prompt`, {
        body: {text: buildPrompt(messages)},
        signal: controller.signal,
      });
      let assistant;
      while (!assistant) {
        if (controller.signal.aborted) {
          await this.interrupt(sessionID);
          throw new OpenCodeLocalError(timedOut ? 'OpenCode request timed out' : 'Request cancelled', timedOut ? 504 : 499);
        }
        const pending = await this.request('GET', `${SESSION_PATH}/${encodeURIComponent(sessionID)}/permission`, {signal: controller.signal});
        if ((pending?.data ?? pending ?? []).length) {
          await this.interrupt(sessionID);
          throw new OpenCodeLocalError('OpenCode requested a tool; local text mode does not execute tools', 422);
        }
        const page = await this.request('GET', `${SESSION_PATH}/${encodeURIComponent(sessionID)}/message`, {signal: controller.signal});
        const items = page?.data ?? page ?? [];
        assistant = items.findLast(item => item?.type === 'assistant' && item.time?.completed);
        const idle = items.findLast(item => item?.type === 'idle');
        if (assistant) break;
        if (idle && idle.outcome !== 'succeeded') throw mapSessionError(idle.error, `OpenCode session ${idle.outcome}`);
        if (idle?.outcome === 'succeeded') throw new OpenCodeLocalError('OpenCode returned no answer', 502);
        await wait(POLL_INTERVAL_MS, controller.signal);
      }
      if (assistant.error) throw mapSessionError(assistant.error);
      const text = (assistant.content ?? []).filter(part => part?.type === 'text').map(part => part.text ?? '').join('');
      if (!text.trim()) {
        const tool = (assistant.content ?? []).some(part => part?.type === 'tool');
        throw new OpenCodeLocalError(tool
          ? 'OpenCode requested a tool; local text mode does not execute tools'
          : 'OpenCode returned no answer', tool ? 422 : 502);
      }
      return {
        text,
        usage: usageFrom(assistant.tokens),
        finishReason: finishReason(assistant.finish),
        model: model.id,
      };
    } catch (error) {
      if (controller.signal.aborted && sessionID) await this.interrupt(sessionID);
      if (timedOut && error instanceof OpenCodeLocalError && error.status === 499) {
        throw new OpenCodeLocalError('OpenCode request timed out', 504);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
      if (sessionID) await this.deleteSession(sessionID);
    }
  }

  async interrupt(sessionID) {
    try {
      await this.request('POST', `${SESSION_PATH}/${encodeURIComponent(sessionID)}/interrupt`, {timeoutMs: 5000});
    } catch {}
  }

  async deleteSession(sessionID) {
    try {
      await this.request('DELETE', `${SESSION_PATH}/${encodeURIComponent(sessionID)}`, {timeoutMs: 5000});
    } catch {}
  }

  async killChild() {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }

  async close() {
    await this.killChild();
    if (this.root) await rm(this.root, {recursive: true, force: true});
  }
}

function parseModelFilter(value) {
  if (!value) return null;
  const models = value.split(',').map(item => item.trim()).filter(Boolean);
  return models.length ? models : null;
}

function usageFrom(tokens) {
  if (!tokens) return undefined;
  const input = (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);
  const output = (tokens.output ?? 0) + (tokens.reasoning ?? 0);
  return {prompt_tokens: input, completion_tokens: output, total_tokens: input + output};
}

function finishReason(finish) {
  if (finish === 'length') return 'length';
  if (finish === 'content-filter') return 'content_filter';
  return 'stop';
}
