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

test('native harness client discovers engines and binds streamed replies to sessions', { skip: process.platform !== 'darwin', timeout: 60000 }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'multivibe-native-harness-client-'));
  let body;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers['x-admin-token'], 'fixture-admin');
    if (req.url === '/admin/host-conversation-harnesses') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ harnesses: [
        { id: 'native', name: 'MultiVibe natif', available: true, configured: true, description: 'direct', capabilities: { sessions: true, streaming: true, tools: false, longTermMemory: false }, popularityRank: 0 },
        { id: 'hermes-agent', name: 'Hermes Agent', available: true, configured: true, description: 'memory', capabilities: { sessions: true, streaming: true, tools: true, longTermMemory: true }, popularityRank: 5 },
        { id: 'pi', name: 'Pi', available: true, configured: true, description: 'session', capabilities: { sessions: true, streaming: true, tools: false, longTermMemory: false }, popularityRank: 6 },
      ] })); return;
    }
    if (req.url === '/admin/host-conversation-harnesses/pi/install') {
      assert.equal(req.method, 'POST');
      res.setHeader('content-type', 'text/event-stream');
      res.write('data: {"type":"log","line":"Downloading Pi…"}\n\n');
      res.end('data: {"type":"result"}\n\n'); return;
    }
    if (req.url === '/admin/host-harnesses/pi/install') {
      assert.equal(req.method, 'POST');
      res.setHeader('content-type', 'application/json');
      res.end('{"harness":{"id":"pi"}}'); return;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    body = JSON.parse(raw);
    res.setHeader('content-type', 'text/event-stream');
    res.write('data: {"type":"text","text":"Bon"}\n\n');
    res.write('data: {"type":"text","text":"Bonjour"}\n\n');
    res.end('data: {"type":"result","text":"Bonjour","sessionId":"session-1"}\n\n');
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const binary = path.join(temporary, 'test');
    await execute('xcrun', ['swiftc', '-parse-as-library', '-target', 'arm64-apple-macos13.0',
      path.join(root, 'packaging/macos/NativeHarnessClient.swift'),
      path.join(root, 'packaging/macos/validation/NativeHarnessClientHarness.swift'), '-o', binary]);
    const { stdout } = await execute(binary, [String(server.address().port)]);
    assert.match(stdout, /PASS native harness discovery/);
    assert.deepEqual(body, { conversationId: '11111111-1111-4111-8111-111111111111', prompt: 'Bonjour', model: 'gpt-test' });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});
