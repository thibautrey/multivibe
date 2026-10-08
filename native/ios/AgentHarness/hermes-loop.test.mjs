import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHermesTurn, validateTranscript, normalizeCalls, validateArguments } from './hermes-loop.mjs';
const tool = { name: 'read', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } };
const call = (name = 'read', args = '{"query":"x"}', id = 'a') => ({ id, type: 'function', function: { name, arguments: args } });
const input = { messages: [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'Read' }], tools: [tool] };
function host(replies, execute = async () => ({ content: 'EVIDENCE' })) {
  const snapshots = [], checkpoints = [], modelInputs = [], executions = [];
  return { snapshots, checkpoints, modelInputs, executions, checkpoint: async (messages, state) => { snapshots.push(messages); checkpoints.push({ messages, state }); },
    model: async messages => { validateTranscript(messages); modelInputs.push(messages); return replies.shift() ?? { content: 'Done' }; },
    execute: async (...args) => { executions.push(args); return execute(...args); } };
}
test('Hermes sequential round stages intent, keeps every duplicate ID result, and continues with evidence', async () => {
  const h = host([{ tool_calls: [call(), call('read', '{"query":"y"}')] }]);
  const result = await runHermesTurn(input, h);
  assert.deepEqual(h.modelInputs[1].filter(m => m.role === 'tool').map(m => m.tool_call_id), ['a', 'a_d2']);
  assert.equal(h.snapshots.find(messages => messages.at(-1).tool_calls)?.at(-1).tool_calls.length, 2);
  assert.equal(h.snapshots.find(messages => messages.at(-1).role === 'tool').at(-1).content, '{"isError":false,"content":"EVIDENCE"}');
  validateTranscript(result.messages);
});
test('failed checkpoint prevents native side effects', async () => {
  const h = host([{ tool_calls: [call()] }]);
  h.checkpoint = async messages => { if (messages.at(-1).tool_calls) throw new Error('disk full'); };
  await assert.rejects(runHermesTurn(input, h), /disk full/);
  assert.equal(h.executions.length, 0);
});
test('mixed unknown tool batch retains errors and executes only valid calls', async () => {
  const h = host([{ tool_calls: [call('unknown'), call('read')] }]);
  await runHermesTurn(input, h);
  assert.equal(h.executions.length, 1);
  assert.match(h.modelInputs[1].find(m => m.role === 'tool').content, /Unknown tool/);
});
test('three unknown-only rounds stop rather than loop forever', async () => {
  const h = host(Array.from({ length: 3 }, () => ({ tool_calls: [call('unknown')] })));
  await assert.rejects(runHermesTurn(input, h), /three times/);
  assert.equal(h.modelInputs.length, 3); assert.equal(h.executions.length, 0);
});
test('truncated JSON refuses the entire batch before execution', async () => {
  const h = host([{ tool_calls: [call(), call('read', '{"query":')] }]);
  await assert.rejects(runHermesTurn(input, h), /Truncated/); assert.equal(h.executions.length, 0);
});
test('complete malformed JSON retries twice then returns paired errors', async () => {
  const h = host(Array.from({ length: 3 }, () => ({ tool_calls: [call('read', '{bad}')] })));
  await runHermesTurn(input, h); assert.equal(h.executions.length, 0);
  assert.equal(h.modelInputs[1].length, input.messages.length);
  assert.match(h.modelInputs[3].find(m => m.role === 'tool').content, /isError.*true/);
});
test('schema violations never reach native tools', async () => {
  const h = host([{ tool_calls: [call('read', '{}')] }]); await runHermesTurn(input, h);
  assert.equal(h.executions.length, 0); assert.match(h.modelInputs[1].find(m => m.role === 'tool').content, /required/);
});
test('thrown tool failures remain error results, not successful evidence', async () => {
  const h = host([{ tool_calls: [call()] }], async () => { throw new Error('HTTP 404'); });
  await runHermesTurn(input, h); assert.match(h.modelInputs[1].find(m => m.role === 'tool').content, /isError.*true.*404/);
});
test('permission refusal closes remaining calls without executing them', async () => {
  const h = host([{ tool_calls: [call(), call('read', '{"query":"second"}')] }], async () => ({ content: 'Denied', terminal: true, isError: true }));
  const result = await runHermesTurn(input, h);
  assert.equal(h.executions.length, 1); assert.equal(h.modelInputs.length, 1); assert.equal(result.finalText, 'Denied'); validateTranscript(result.messages);
});
test('cancellation after model and between tools prevents future side effects', async () => {
  for (const phase of ['model', 'tool']) {
    const controller = new AbortController();
    const h = host([{ tool_calls: [call(), call('read', '{"query":"second"}')] }], async () => { controller.abort(); return { content: 'done' }; });
    h.signal = controller.signal;
    if (phase === 'model') { const model = h.model; h.model = async messages => { const reply = await model(messages); controller.abort(); return reply; }; }
    await assert.rejects(runHermesTurn(input, h), /Cancelled/);
    assert.equal(h.executions.length, phase === 'model' ? 0 : 1);
  }
});
test('output length continuation retains preceding answer and upstream nudge', async () => {
  const h = host([{ content: 'first', finish_reason: 'MAX_TOKENS' }, { content: 'second' }]);
  const result = await runHermesTurn(input, h);
  assert.match(h.modelInputs[1].at(-1).content, /Continue exactly/);
  assert.equal(h.modelInputs[1].at(-2).content, 'first'); assert.equal(result.completed, true);
});
test('empty tool response and missing tool call retry boundedly', async () => {
  for (const replies of [[{ tool_calls: [call()] }, { content: '' }, { content: 'done' }], [{ finish_reason: 'tool_calls' }, { content: 'done' }]]) {
    const h = host(replies); await runHermesTurn(input, h); assert.ok(h.modelInputs.length > 1);
  }
});
test('repeated tool work stops after two executions and bounded inference', async () => {
  const h = host(Array.from({ length: 20 }, () => ({ tool_calls: [call()] })));
  await assert.rejects(runHermesTurn(input, h), /limite/); assert.equal(h.executions.length, 2); assert.equal(h.modelInputs.length, 16);
});
test('nested schemas constrain arguments and unknown keywords fail closed', () => {
  assert.throws(() => validateArguments({ type: 'object', unevaluatedProperties: false }, {}), /Unsupported/);
  assert.throws(() => validateArguments({ type: 'array', items: { type: 'string' }, maxItems: 1 }, ['x', 'y']), /item count/);
  assert.throws(() => validateArguments({ type: 'object', properties: { count: { type: 'integer', minimum: 1 } } }, { count: 0 }), /out of range/);
});
test('compaction validator rejects orphan or missing results', () => {
  assert.throws(() => validateTranscript([{ role: 'tool', tool_call_id: 'missing' }]), /Orphan/);
  assert.throws(() => validateTranscript([{ role: 'assistant', tool_calls: [call()] }, { role: 'user' }]), /Missing/);
});

test('tool IDs match executed pinned upstream Python helpers, including collisions and composite IDs', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const fixtures = JSON.parse(execFileSync('python3', [fileURLToPath(new URL('./hermes-upstream-fixtures.py', import.meta.url))], { encoding: 'utf8' }));
  for (const fixture of fixtures) assert.deepEqual(normalizeCalls(fixture.ids.map(id => call('read', '{}', id)), 1).map(item => item.id), fixture.expected);
});

test('a third malformed batch skips valid peers instead of executing only half a batch', async () => {
  const h = host(Array.from({ length: 3 }, () => ({ tool_calls: [call('read', '{bad}'), call('read', '{"query":"valid"}', 'second')] })));
  await runHermesTurn(input, h);
  assert.equal(h.executions.length, 0);
  const results = h.modelInputs[3].filter(m => m.role === 'tool');
  assert.equal(results.length, 2); assert.match(results[1].content, /Skipped/);
});
test('object and empty arguments normalize like upstream before validation', async () => {
  const optional = { ...input, tools: [{ name: 'read', parameters: { type: 'object' } }] };
  for (const args of ['', { query: 'x' }]) {
    const h = host([{ tool_calls: [call('read', args)] }]); await runHermesTurn(optional, h);
    assert.deepEqual(h.executions[0][1], typeof args === 'string' ? {} : args);
  }
});

test('relaunch from result checkpoint continues inference without replaying successful calls', async () => {
  const first = host([{ tool_calls: [call()] }]);
  const originalCheckpoint = first.checkpoint;
  first.checkpoint = async (messages, state) => {
    await originalCheckpoint(messages, state);
    if (messages.at(-1).role === 'tool') throw new Error('simulated crash after durable write');
  };
  await assert.rejects(runHermesTurn(input, first), /simulated crash/);
  assert.equal(first.executions.length, 1);
  const resume = first.checkpoints.at(-1);
  const second = host([{ tool_calls: [call()] }, { content: 'Already done' }]);
  await runHermesTurn({ ...input, resume }, second);
  assert.equal(second.executions.length, 0);
  assert.match(second.modelInputs[0].at(-1).content, /EVIDENCE/);
});
test('relaunch with unresolved tool intent refuses before inference or execution', async () => {
  const resume = { messages: [...input.messages, { role: 'assistant', tool_calls: [call()] }], state: {} };
  const h = host([]);
  await assert.rejects(runHermesTurn({ ...input, resume }, h), /Unresolved tool call/);
  assert.equal(h.modelInputs.length, 0); assert.equal(h.executions.length, 0);
});
test('crash during model inference resumes a safe request and preserves consumed budget', async () => {
  const first = host([]); first.model = async () => { throw new Error('model process died'); };
  await assert.rejects(runHermesTurn(input, first), /model process died/);
  const resume = first.checkpoints.at(-1);
  assert.equal(resume.state.rounds, 1);
  const second = host([{ content: 'Recovered' }]);
  await runHermesTurn({ ...input, resume }, second);
  assert.equal(second.checkpoints.at(-1).state.rounds, 2);
  assert.equal(second.executions.length, 0);
});
test('completed resume returns saved answer without model or tool work', async () => {
  const first = host([{ content: 'Final answer' }]); await runHermesTurn(input, first);
  const second = host([]);
  const result = await runHermesTurn({ ...input, resume: first.checkpoints.at(-1) }, second);
  assert.equal(result.finalText, 'Final answer'); assert.equal(second.modelInputs.length, 0);
});

test('tool schemas and history are byte stable across equivalent insertion orders', async () => {
  const firstTools = [
    { name: 'z', description: '  ZWO\n', parameters: { properties: { b: { type: 'number' }, a: { type: 'string' } }, type: 'object' } },
    { name: 'a', parameters: { type: 'object', properties: {} } },
  ];
  const secondTools = [
    { parameters: { properties: {}, type: 'object' }, name: 'a' },
    { parameters: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } }, description: '  ZWO\n', name: 'z' },
  ];
  const original = JSON.stringify(firstTools);
  const captured = [];
  for (const tools of [firstTools, secondTools]) {
    const h = host([]);
    h.model = async (messages, schemas) => {
      assert.deepEqual(messages, input.messages);
      captured.push(JSON.stringify(schemas));
      return { content: 'Done' };
    };
    await runHermesTurn({ ...input, tools }, h);
  }
  assert.equal(captured[0], captured[1]);
  assert.equal(JSON.stringify(firstTools), original);
  assert.equal(JSON.parse(captured[0])[1].description, '  ZWO\n');
});
