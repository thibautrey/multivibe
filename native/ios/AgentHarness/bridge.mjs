// Native transport for the pinned Hermes portable mobile loop. Swift owns all I/O.
import 'fast-text-encoding';
import { iosToolSchemas, executeIOSTool } from './ios-tools.mjs';
import { runHermesTurn, hermesCommit } from './hermes-loop.mjs';
import URL from 'core-js-pure/features/url/index.js';
import URLSearchParams from 'core-js-pure/features/url-search-params/index.js';
import { AbortController, AbortSignal } from 'abort-controller/dist/abort-controller.mjs';
globalThis.URL ??= URL;
globalThis.URLSearchParams ??= URLSearchParams;
globalThis.AbortController ??= AbortController;
globalThis.AbortSignal ??= AbortSignal;
globalThis.crypto ??= { getRandomValues(array) { array.set(globalThis.__randomBytes(array.length)); return array; } };
globalThis.console ??= { log() {}, warn() {}, error() {}, debug() {} };
globalThis.structuredClone ??= value => JSON.parse(JSON.stringify(value));
let active;
function request(state, kind, value) {
  if (state.controller.signal.aborted) return Promise.reject(new Error('Cancelled'));
  return new Promise((resolve, reject) => {
    const id = `${state.generation}:${++state.sequence}`;
    state.pending.set(id, { resolve, reject });
    state.requests.push({ id, kind, ...value });
  });
}
let generation = 0;
const bridge = {
  version: 'hermes-mobile/' + hermesCommit,
  start(json) {
    if (active && !active.done) throw new Error('A Hermes run is already active');
    const input = JSON.parse(json);
    const state = active = { generation: ++generation, sequence: 0, pending: new Map(), requests: [], done: false, controller: new AbortController() };
    const tools = input.tools.map(({ function: tool }) => iosToolSchemas.find(item => item.name === tool.name) ?? tool);
    runHermesTurn({ ...input, tools }, {
      signal: state.controller.signal,
      checkpoint: async (messages, runtime) => {
        if (input.durable) await request(state, 'checkpoint', { messages: JSON.stringify(messages), state: JSON.stringify(runtime) });
        else state.transcript = messages; // workspace-free titles and compatibility callers only
      },
      ...(input.compaction === true ? {
        measure: (messages, declarations, reservedOutputTokens) => request(state, 'contextBudget', {messages: JSON.stringify(messages), tools: JSON.stringify(declarations.map(tool => ({type:'function',function:tool}))), reservedOutputTokens}),
        summarize: (messages, reservedOutputTokens) => request(state, 'summary', {messages: JSON.stringify(messages), reservedOutputTokens})
      } : {}),
      model: (messages, declarations) => request(state, 'model', { messages: JSON.stringify(messages), tools: JSON.stringify(declarations.map(tool => ({ type: 'function', function: tool }))) }),
      execute: (name, args, callID) => {
        const native = (name, args) => request(state, 'tool', { name, arguments: JSON.stringify(args), callID });
        return iosToolSchemas.some(tool => tool.name === name)
          ? executeIOSTool(name, args, native, state.controller.signal) : native(name, args);
      }
    }).then(result => { state.finalText = result.finalText; state.done = true; })
      .catch(error => { state.error = String(error.message ?? error); state.done = true; });
  },
  poll() { return JSON.stringify({ requests: active.requests.splice(0), done: active.done, error: active.error, finalText: active.finalText }); },
  resolve(id, json, failed = false) {
    const pending = active.pending.get(id); if (!pending) return;
    active.pending.delete(id);
    if (failed) pending.reject(new Error(json));
    else { try { pending.resolve(JSON.parse(json)); } catch (error) { pending.reject(error); } }
  },
  cancel() {
    if (!active) return;
    active.controller.abort();
    active.requests.length = 0;
    for (const pending of active.pending.values()) pending.reject(new Error('Cancelled'));
    active.pending.clear();
  }
};
globalThis.HermesNative = bridge;
// Binary bridge compatibility while resource/class names migrate in app releases.
globalThis.PiNative = bridge;
