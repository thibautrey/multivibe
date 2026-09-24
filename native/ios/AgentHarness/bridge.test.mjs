import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { randomBytes } from 'node:crypto';
const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('bridge.mjs', import.meta.url))], bundle: true,
  platform: 'browser', format: 'iife', target: 'safari18', define: { global: 'globalThis' }, write: false });
const schema = [{ type: 'function', function: { name: 'fetch_website', description: 'Read a URL',
  parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } } }];
const call = (args = { url: 'https://example.com' }) => ({ role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'fetch_website', arguments: JSON.stringify(args) } }] });
async function drive(respond, execute, tools = schema) {
  const context = vm.createContext({ __randomBytes: n => [...randomBytes(n)] });
  vm.runInContext(outputFiles[0].text, context);
  const bridge = context.PiNative;
  bridge.start(JSON.stringify({ messages: [{ role: 'system', content: 'Test assistant' }, { role: 'user', content: 'Read the website' }], tools }));
  const requests = [];
  for (let tick = 0; tick < 200; tick++) {
    await new Promise(resolve => setImmediate(resolve));
    const status = JSON.parse(bridge.poll());
    if (status.error) throw new Error(status.error);
    if (status.done) return { ...status, requests };
    for (const request of status.requests) {
      requests.push(request);
      const result = request.kind === 'model' ? await respond(request, requests) : await execute(request);
      bridge.resolve(request.id, JSON.stringify(result));
    }
  }
  throw new Error('Pi did not terminate');
}
test('upstream Pi executes a tool and keeps its matching result for the next turn', async () => {
  let turns = 0;
  const result = await drive(request => {
    if (++turns === 1) { assert.match(JSON.parse(request.messages)[0].content, /Test assistant/); return call(); }
    const messages = JSON.parse(request.messages);
    assert.equal(messages.at(-1).role, 'tool');
    assert.equal(messages.at(-1).tool_call_id, 'call_1');
    assert.match(messages.at(-1).content, /ORION/);
    return { role: 'assistant', content: 'ORION' };
  }, async () => ({ content: 'ORION', isError: false }));
  assert.equal(result.requests.filter(r => r.kind === 'tool').length, 1);
});
test('upstream schema validation rejects malformed arguments before native execution', async () => {
  let turns = 0, executions = 0;
  await drive(request => {
    if (++turns === 1) return call({});
    assert.match(JSON.parse(request.messages).at(-1).content, /true/);
    return { role: 'assistant', content: 'Please provide a URL' };
  }, async () => { executions++; return { content: 'bad' }; });
  assert.equal(executions, 0);
});
test('permission refusal terminates without additional inference or network work', async () => {
  const result = await drive(() => call(), async () => ({ content: 'Accès refusé.', isError: true, terminal: true }));
  assert.equal(result.finalText, 'Accès refusé.');
  assert.equal(result.requests.filter(r => r.kind === 'model').length, 1);
});
test('HTTP failures stay errors and get a recovery instruction', async () => {
  let turns = 0;
  await drive(request => {
    if (++turns === 1) return call();
    const messages = JSON.parse(request.messages);
    assert.match(messages[0].content, /tool failed/);
    assert.match(messages.at(-1).content, /404/);
    assert.match(messages.at(-1).content, /isError.*true/);
    return { role: 'assistant', content: 'Which city?' };
  }, async () => ({ content: 'HTTP 404. Correct the URL.', isError: true }));
});
test('repeated identical calls are blocked and a bounded run eventually stops', async () => {
  let executions = 0;
  await assert.rejects(drive(() => call(), async () => { executions++; return { content: 'Already read', isError: false }; }), /limite/);
  assert.equal(executions, 2);
});
test('a plain response does not request native tools', async () => {
  const result = await drive(() => ({ role: 'assistant', content: 'Bonjour' }), () => assert.fail('Unexpected tool'), []);
  assert.equal(result.requests.length, 1);
});
