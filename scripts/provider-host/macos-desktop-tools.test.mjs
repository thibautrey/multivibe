import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { HostHarnessRuntime } from '../../src/host/harness-runtime/runtime.ts';
import { harnessRuntimeRoutes } from '../../src/host/harness-runtime/routes.ts';
import { JsonPeer } from '../../src/host/harness-runtime/process.ts';
import { buildAndInstallCef } from './cef-runtime.mjs';
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const waitFor = async check => { const deadline = Date.now() + 30000; while (!check()) { if (Date.now() > deadline) throw new Error('Native Desktop provider did not attach'); await new Promise(resolve => setTimeout(resolve, 100)); } };

test('MCP harness reaches the real native Host controller and embedded Chromium through the session bridge', { skip: process.platform !== 'darwin', timeout: 300000 }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mv200-desktop-e2e-'));
  let runtime, peer, provider, finish, server;
  try {
    const key = randomBytes(24).toString('hex');
    runtime = new HostHarnessRuntime(path.join(temporary, 'runtime'), {
      list: async () => [{ id: 'pi', detected: true, configured: true }], executablePath: async () => process.execPath,
    }, ctx => ({
      start: async () => {}, prompt: async () => new Promise(resolve => { finish = resolve; }), interrupt: async () => finish?.(), close: () => finish?.(),
      inspect: async () => ({}), compact: async () => ({}), configure: async () => ({}), native: async () => ({}),
    }));
    const app = express();
    app.get('/fixture', (_req, res) => res.type('html').send('<!doctype html><title>Outils Host</title><body style="font:24px system-ui;padding:32px"><h1>MultiVibe Host</h1><label>Message <input aria-label="Message"></label><button onclick="document.querySelector(\'output\').textContent=\'Host confirmé : \'+document.querySelector(\'input\').value">Valider</button><p><output>En attente</output></p>'));
    app.use('/admin/host-harness-runtime/v1', (req, res, next) => req.headers['x-fixture-key'] === key ? next() : res.sendStatus(403), harnessRuntimeRoutes(runtime));
    server = createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const session = await runtime.create({ harnessId: 'pi' });
    const appPath = path.join(temporary, 'Desktop Tools.app'), contents = path.join(appPath, 'Contents');
    await mkdir(path.join(contents, 'MacOS'), { recursive: true }); await mkdir(path.join(contents, 'Resources'), { recursive: true });
    await writeFile(path.join(contents, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>cloud.multivibe.desktoptools.fixture</string><key>CFBundleExecutable</key><string>Desktop Tools</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
    const cef = await buildAndInstallCef({ architecture: process.arch === 'arm64' ? 'arm64' : 'x86_64', contents, temporary, repository: root });
    const binary = path.join(contents, 'MacOS', 'Desktop Tools');
    const sources = ['ComputerUseTypes', 'ComputerUseMacDriver', 'ComputerUseController', 'ChromiumBrowser', 'NativeHarnessRuntimeTypes', 'NativeHarnessRuntimeClient', 'validation/DesktopToolsProviderHarness'];
    await execute('xcrun', ['swiftc', '-parse-as-library', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`, ...sources.map(s => path.join(root, `packaging/macos/${s}.swift`)), cef.bridge, cef.wrapper, '-lc++', '-o', binary], { maxBuffer: 2 * 1024 * 1024 });
    await chmod(binary, 0o755);
    const entitlements = path.join(temporary, 'test.entitlements');
    await writeFile(entitlements, '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>');
    await execute('codesign', ['--force', '--deep', '--sign', '-', path.join(contents, 'Frameworks/Chromium Embedded Framework.framework')]);
    for (const signed of [path.join(contents, 'Frameworks/MultiVibe Chromium Helper.app'), appPath]) await execute('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', entitlements, signed]);
    const fixtureURL = `http://127.0.0.1:${server.address().port}/fixture`;
    provider = spawn(binary, [String(server.address().port), session.id, fixtureURL, key], { env: { ...process.env, MULTIVIBE_CHROMIUM_TESTING: '1', MULTIVIBE_CHROMIUM_PROFILE_DIR: path.join(temporary, 'profile') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; const capture = chunk => { output = (output + chunk).slice(-1000000); }; provider.stdout.on('data', capture); provider.stderr.on('data', capture);
    await waitFor(() => runtime.desktop.available(session.id));
    await runtime.command(session.id, { id: randomUUID(), type: 'prompt', parts: [{ type: 'text', text: 'Validate Host browser tools' }] });
    await waitFor(() => Boolean(finish));
    const connection = await runtime.desktop.connection(session.id);
    peer = new JsonPeer(spawn(connection.command, connection.args, { cwd: root, env: { ...process.env, ...connection.env }, stdio: 'pipe' }), () => {}, async () => ({}), () => {}, () => {});
    await peer.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'harness-e2e', version: '1' } }); peer.notify('notifications/initialized');
    const tools = await peer.request('tools/list'); assert.deepEqual(tools.tools.map(t => t.name), ['browser', 'computer']);
    const call = async args => { const result = await peer.request('tools/call', { name: 'browser', arguments: args }, 60000); assert.ok(!result.isError, result.content[0].text); return result; };
    const observation = result => { const text = result.content.find(c => c.type === 'text').text; const id = text.match(/^Observation: (.+)$/m)[1]; const snapshot = JSON.parse(text.split('\n').find(line => line.startsWith('{'))); return { id, snapshot }; };
    let result = await call({ action: 'navigate', url: fixtureURL });
    let state = observation(result); const field = state.snapshot.elements.find(e => e.label === 'Message');
    result = await call({ action: 'type', observation: state.id, element: field.id, text: 'MCP vers Chromium' });
    state = observation(result); const button = state.snapshot.elements.find(e => e.label === 'Valider');
    result = await call({ action: 'click', observation: state.id, element: button.id });
    assert.match(result.content[0].text, /Host confirmé : MCP vers Chromium/);
    assert.ok(Buffer.from(result.content.find(c => c.type === 'image').data, 'base64').length > 1000);
    await runtime.command(session.id, { id: randomUUID(), type: 'interrupt' });
    await waitFor(() => provider.exitCode !== null); assert.equal(provider.exitCode, 0, output.slice(-4000));
    assert.match(output, /PASS native Host provider/);
    console.log('PASS real MCP → session broker → native Host controller → Chromium navigation, input, click, screenshot and release');
  } finally {
    peer?.close(); provider?.kill('SIGTERM'); await runtime?.close();
    server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});
