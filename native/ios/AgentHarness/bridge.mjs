// The loop, argument validation and tool-result ordering are upstream Pi code.
// This file adapts its transport to the app's native GGUF engine and tool executor.
import 'fast-text-encoding';
import URL from 'core-js-pure/features/url/index.js';
import URLSearchParams from 'core-js-pure/features/url-search-params/index.js';
globalThis.URL ??= URL;
globalThis.URLSearchParams ??= URLSearchParams;
import { AbortController, AbortSignal } from 'abort-controller/dist/abort-controller.mjs';
import { runAgentLoop } from '@earendil-works/pi-agent-core';
import { AssistantMessageEventStream, getCurrentTools, getCurrentSystemPrompt } from '@earendil-works/pi-ai';

globalThis.AbortController ??= AbortController;
globalThis.AbortSignal ??= AbortSignal;
globalThis.crypto ??= { getRandomValues(array) { array.set(globalThis.__randomBytes(array.length)); return array; } };
globalThis.console ??= { log() {}, warn() {}, error() {}, debug() {} };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { id: 'native', name: 'Native', api: 'openai-completions', provider: 'multivibe-native',
  baseUrl: '', reasoning: false, input: ['text'], contextWindow: 4096, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function assistant(content = [], stopReason = 'stop') {
  return { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    usage: structuredClone(usage), stopReason, timestamp: Date.now() };
}
// JavaScriptCore has no browser structuredClone; Pi's JSON message values need no DOM support.
globalThis.structuredClone ??= value => JSON.parse(JSON.stringify(value));
const textOf = content => typeof content === 'string' ? content : (content ?? []).filter(p => p.type === 'text').map(p => p.text).join('');
function nativeMessages(context) {
  const messages = [{ role: 'system', content: getCurrentSystemPrompt(context.messages) }];
  for (const message of context.messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') messages.push({ role: 'user', content: textOf(message.content) });
    if (message.role === 'assistant') {
      const calls = message.content.filter(p => p.type === 'toolCall');
      messages.push({ role: 'assistant', content: textOf(message.content), ...(calls.length ? { tool_calls: calls.map(call => ({
        id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) }
      })) } : {}) });
    }
    if (message.role === 'toolResult') messages.push({ role: 'tool', tool_call_id: message.toolCallId,
      name: message.toolName, content: JSON.stringify({ isError: message.isError, content: textOf(message.content) }) });
  }
  return messages;
}
let active;
function request(kind, value) {
  return new Promise((resolve, reject) => {
    const id = String(++active.sequence);
    active.pending.set(id, { resolve, reject });
    active.requests.push({ id, kind, ...value });
  });
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
async function run(input) {
  let rounds = 0, calls = 0, modelMilliseconds = 0, repairAttempts = 0;
  const repeats = new Map();
  const tools = input.tools.map(({ function: tool }) => ({ ...tool, label: tool.name,
    execute: async (id, args) => {
      const result = await request('tool', { name: tool.name, arguments: JSON.stringify(args), callID: id });
      return { content: [{ type: 'text', text: result.content }], details: result };
    }
  }));
  const messages = input.messages.filter(m => m.role !== 'system').map(m => m.role === 'assistant'
    ? assistant([{ type: 'text', text: m.content }])
    : { role: 'user', content: [{ type: 'text', text: m.content }], timestamp: Date.now() });
  const prompt = messages.pop();
  if (!prompt || prompt.role !== 'user') throw new Error('A user message is required');
  messages.unshift({ role: 'system', content: input.messages.filter(m => m.role === 'system').map(m => m.content).join('\n'), timestamp: 0 });
  const context = { messages, tools };
  let terminalResult, weatherEvidence = false;
  const config = {
    model, convertToLlm: messages => messages, toolExecution: 'sequential',
    prepareRequest: () => {
      if (++rounds > 16 || modelMilliseconds > 120_000) throw new Error('La limite de travail local a été atteinte.');
    },
    beforeToolCall: ({ toolCall }) => {
      const key = toolCall.name + JSON.stringify(stable(toolCall.arguments));
      const count = (repeats.get(key) ?? 0) + 1; repeats.set(key, count);
      if (++calls > 12 || count > 2) return { block: true, reason: 'Repeated identical tool call. Use the existing result, correct the inputs, or ask the user for missing information.' };
    },
    afterToolCall: ({ result, isError }) => {
      if (result.details?.terminal) terminalResult = result.details.content;
      return { isError: isError || result.details?.isError === true };
    },
    finishTurn: ({ toolResults, context, message }) => {
      if (toolResults.some(result => result.toolName === 'weather_forecast')) weatherEvidence = true;
      if (!toolResults.length && input.weather && !weatherEvidence && !terminalResult) {
        if (repairAttempts++ < 1) {
          context.messages.push({ role: 'system', content: 'Call weather_forecast to verify the forecast. Use city empty if the user did not specify a city. Do not invent one.', timestamp: Date.now() });
          return { action: 'continue' };
        }
        terminalResult = 'Pour quelle ville souhaites-tu la météo ?';
      }
      if (!toolResults.length && input.weather) active.finalText = textOf(message.content);
      if (terminalResult) { active.finalText = terminalResult; return { action: 'end' }; }
      if (toolResults.some(result => result.isError) && repairAttempts++ < 2) {
        context.messages.push({ role: 'system', content: 'The tool failed. Read its error, correct the arguments or choose a suitable source. Do not repeat the same failed call. If essential information is missing, ask the user. Answer in the language of the user.', timestamp: Date.now() });
      }
      if (message.stopReason === 'error') active.error = message.errorMessage ?? 'Native inference failed';
    }
  };
  const streamFn = (_model, transcript) => {
    const stream = new AssistantMessageEventStream();
    const start = Date.now();
    request('model', { messages: JSON.stringify(nativeMessages(transcript)), tools: JSON.stringify(getCurrentTools(transcript.messages).map(tool => ({ type: 'function', function: tool }))) })
      .then(reply => {
        modelMilliseconds += Date.now() - start;
        const content = reply.content ? [{ type: 'text', text: reply.content }] : [];
        for (const call of reply.tool_calls ?? []) content.push({ type: 'toolCall', id: call.id,
          name: call.function.name, arguments: JSON.parse(call.function.arguments) });
        const message = assistant(content, reply.tool_calls?.length ? 'toolUse' : 'stop');
        stream.push({ type: 'done', reason: message.stopReason, message });
      }).catch(error => {
        const message = assistant([], active.controller.signal.aborted ? 'aborted' : 'error');
        message.errorMessage = String(error.message ?? error);
        stream.push({ type: 'error', reason: message.stopReason, error: message });
      });
    return stream;
  };
  await runAgentLoop([prompt], context, config, () => {}, active.controller.signal, streamFn);
}
globalThis.PiNative = {
  version: '0.87.1',
  start(json) {
    if (active && !active.done) throw new Error('A Pi run is already active');
    active = { sequence: 0, pending: new Map(), requests: [], done: false, controller: new AbortController() };
    run(JSON.parse(json)).then(() => { active.done = true; }).catch(error => { active.error = String(error.message ?? error); active.done = true; });
  },
  poll() { return JSON.stringify({ requests: active.requests.splice(0), done: active.done, error: active.error, finalText: active.finalText }); },
  resolve(id, json, failed = false) {
    const pending = active.pending.get(id); if (!pending) return;
    active.pending.delete(id);
    if (failed) pending.reject(new Error(json)); else pending.resolve(JSON.parse(json));
  },
  cancel() {
    active.controller.abort();
    for (const pending of active.pending.values()) pending.reject(new Error('Cancelled'));
    active.pending.clear();
  }
};
