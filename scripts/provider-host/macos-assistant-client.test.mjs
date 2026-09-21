import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

test('native assistant uses Host API with bounded input, model validation, cancellation and no redirects', { skip: process.platform !== 'darwin', timeout: 60000 }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'multivibe-assistant-test-'));
  let leaked = false;
  const calls = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/leaked') { leaked = true; res.end('{}'); return; }
    if (!['Bearer fixture-only-token', 'Bearer fixture-local-fallback-token'].includes(req.headers.authorization)) { res.writeHead(401).end(); return; }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') {
      if (req.headers.authorization === 'Bearer fixture-local-fallback-token') { res.writeHead(503).end('{}'); return; }
      res.end(JSON.stringify({ data: ['slow', 'redirect', 'normal', 'error', 'empty', 'normal', 'stream', 'truncated'].map(id => ({id})) })); return;
    }
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); calls.push(body);
    if (body.model === 'redirect') { res.writeHead(307, { Location: '/leaked' }).end(); return; }
    if (body.model === 'error') { res.writeHead(503).end('{}'); return; }
    if (body.model === 'slow') { const timer = setTimeout(() => res.end('{}'), 2000); res.on('close', () => clearTimeout(timer)); return; }
    if (body.stream) {
      assert.deepEqual(body.messages, [{ role: 'user', content: 'Bonjour' }, { role: 'assistant', content: 'Salut' }, { role: 'user', content: 'Suite' }]);
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"Bonjour "}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"été"}}]}\n\n');
      if (body.model !== 'truncated') res.write('data: [DONE]\n\n');
      res.end(); return;
    }
    res.end(JSON.stringify({ choices: [{ message: { content: body.model === 'empty' ? '' : 'Réponse fixture' } }] }));
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const binary = path.join(temporary, 'test');
    await execute('xcrun', ['swiftc', '-parse-as-library', '-target', 'arm64-apple-macos13.0', path.join(root, 'packaging/macos/AppleFoundationModel.swift'), path.join(root, 'packaging/macos/HostAssistantClient.swift'), path.join(root, 'packaging/macos/validation/AssistantClientHarness.swift'), '-o', binary]);
    const { stdout } = await execute(binary, [String(server.address().port)]);
    assert.match(stdout, /PASS remote and Apple-local catalogs/);
    assert.equal(leaked, false);
    assert.equal(calls.length, 7);
    assert.deepEqual(calls[0], { model: 'normal', stream: false, messages: [{ role: 'user', content: 'Bonjour' }] });
    console.log(stdout.trim());
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});
