import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { patchRhoPromptCache } from './patch-rho-prompt-cache.mjs';

test('refuses unreviewed upstream versions', () => {
  assert.throws(() => patchRhoPromptCache('unknown source'), /Unsupported Rho/);
  assert.throws(() => patchRhoPromptCache('// MULTIVIBE-103: runtime context belongs to the current turn.\nunknown source'), /Unsupported Rho/);
});

test('actual Rho hook keeps runtime fresh without changing system bytes', {
  skip: !process.env.RHO_CACHE_TEST_SOURCE && 'Set RHO_CACHE_TEST_SOURCE to the reviewed Rho 0.1.12 source',
}, async () => {
  const source = readFileSync(process.env.RHO_CACHE_TEST_SOURCE, 'utf8');
  const patched = patchRhoPromptCache(source);
  assert.equal(patchRhoPromptCache(patched), patched);
  const metaStart = source.indexOf('function buildMetaPrompt(');
  const metaEnd = source.indexOf('\n}\n', metaStart) + 2;
  const hookStart = patched.indexOf('pi.on("before_agent_start",');
  const hookEnd = patched.indexOf('\n\tpi.on("agent_end",', hookStart);
  const code = patched.slice(metaStart, patched.indexOf('\n}\n', metaStart) + 2) + '\n' + patched.slice(hookStart, hookEnd);
  let handler;
  let now = 1000;
  const state = { enabled: true, intervalMs: 60000, nextCheckAt: 121000 };
  const context = {
    pi: { on: (name, callback) => { assert.equal(name, 'before_agent_start'); handler = callback; } },
    Date: { now: () => now }, detectPlatform: () => 'macos', os: { arch: () => 'arm64' },
    process: { env: { SHELL: '/bin/zsh' } }, path: { basename: value => value.split('/').at(-1) },
    HOME: '/synthetic/home', formatInterval: () => '1m', readAgentName: () => 'rho',
    isBrainCacheStale: () => false, hbState: state, hbIsLeader: true,
    vaultGraph: { size: 10 }, IS_SUBAGENT: false,
    cachedBootstrapPrompt: 'bootstrap', cachedBrainPrompt: 'brain',
  };
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const first = await handler({ systemPrompt: 'caller instructions' }, {});
  now = 61000;
  context.vaultGraph.size = 12;
  const second = await handler({ systemPrompt: 'caller instructions' }, {});
  assert.equal(first.systemPrompt, second.systemPrompt);
  assert.match(first.systemPrompt, /^caller instructions\n\n## Brain Tool/);
  assert.match(first.systemPrompt, /bootstrap\n\nbrain$/);
  assert.doesNotMatch(first.systemPrompt, /Heartbeat|## Runtime/);
  assert.match(first.message.content, /next in 2m/);
  assert.match(second.message.content, /next in 1m/);
  assert.match(second.message.content, /12 notes/);
  assert.equal(second.message.display, false);
  // Runtime bytes retain the original function's exact content for each turn.
  const original = { ...context };
  vm.runInNewContext(ts.transpileModule(source.slice(metaStart, metaEnd), {}).outputText, original);
  const old = original.buildMetaPrompt({ agentName: 'rho', hbState: state, hbIsLeader: true, vaultNoteCount: 12, ctx: {}, isSubagent: false });
  assert.equal(second.message.content, old.slice(0, old.indexOf('\n\n## Brain Tool')));
  assert.equal(second.systemPrompt, 'caller instructions\n\n' + old.slice(old.indexOf('## Brain Tool')) + '\n\nbootstrap\n\nbrain');
});
