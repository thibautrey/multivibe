import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

test('computer use controls real WebKit through the Host tool loop and enforces permissions', { skip: process.platform !== 'darwin', timeout: 120000 }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'multivibe-computer-use-'));
  let fixturePID;
  let turns = 0;
  let verified = false;
  let serverFailure;
  const server = createServer(async (req, res) => {
    try {
    if (req.url === '/fixture') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html lang="fr"><title>Recette computer use</title><body style="font:24px system-ui;padding:40px"><h1>Recette MultiVibe</h1><label>Votre texte <input aria-label="Votre texte" id="entry"></label><button id="verify" onclick="document.getElementById('result').textContent='Computer use confirmé : '+document.getElementById('entry').value">Vérifier</button><p id="result">En attente</p><pre id="events"></pre><script>for(const name of ["mousedown","mouseup","click"]){document.addEventListener(name,e=>document.getElementById("events").textContent+=name+":"+e.target.id+":"+e.clientX+","+e.clientY+":"+e.isTrusted+" ")}</script><input type="password" value="SECRET-NOT-FOR-MODEL" aria-label="Secret"><a href="https://example.invalid">Autre site</a></body></html>`); return;
    }
    assert.equal(req.headers.authorization, 'Bearer computer-use-fixture');
    assert.equal(req.url, '/v1/chat/completions');
    let raw = ''; for await (const chunk of req) raw += chunk;
    assert.ok(!raw.includes('SECRET-NOT-FOR-MODEL'));
    const body = JSON.parse(raw);
    assert.equal(body.tools[0].function.name, 'computer');
    assert.equal(body.parallel_tool_calls, false);
    assert.equal(body.model, 'fixture-browser');
    let command;
    if (turns === 0) command = { action: 'navigate', target: 'browser', url: `http://127.0.0.1:${server.address().port}/fixture` };
    else {
      const tool = body.messages.findLast(m => m.role === 'tool');
      assert.ok(tool, 'tool result is included');
      assert.ok(!tool.content.startsWith('ERREUR'), tool.content);
      const observation = tool.content.match(/Observation: ([^\n]+)/)?.[1];
      assert.ok(observation);
      const image = body.messages.findLast(m => Array.isArray(m.content))?.content.find(c => c.type === 'image_url');
      assert.ok(image?.image_url.url.startsWith('data:image/jpeg;base64,'), 'actual screenshot is sent to the model');
      const snapshot = JSON.parse(tool.content.split('\n').find(line => line.startsWith('{')));
      if (turns === 1) {
        const input = snapshot.elements.find(e => e.label === 'Votre texte'); assert.ok(input);
        command = { action: 'type', target: 'browser', observation, element: input.id, text: 'Validation réelle' };
      } else if (turns === 2) {
        const button = snapshot.elements.find(e => e.label === 'Vérifier'); assert.ok(button);
        command = { action: 'click', target: 'browser', observation, element: button.id };
      } else {
        assert.ok(snapshot.text.includes('Computer use confirmé : Validation réelle'), snapshot.text);
        assert.match(snapshot.text, /click:verify:[^ ]+:true/, 'browser click is a trusted native input event');
        verified = true;
      }
    }
    const message = command ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${turns}`, type: 'function', function: { name: 'computer', arguments: JSON.stringify(command) } }] } : { role: 'assistant', content: 'Résultat vérifié dans la page après saisie et clic.' };
    turns++;
    assert.equal(body.stream, true);
    res.setHeader('content-type', 'text/event-stream');
    const frame = delta => res.write('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\n');
    if (command) {
      const call = message.tool_calls[0];
      frame({ tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }] });
      const argumentsText = call.function.arguments;
      for (let offset = 0; offset < argumentsText.length; offset += 7) frame({ tool_calls: [{ index: 0, function: { arguments: argumentsText.slice(offset, offset + 7) } }] });
    } else { frame({ content: message.content.slice(0, 8) }); frame({ content: message.content.slice(8) }); }
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: command ? 'tool_calls' : 'stop' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
    } catch (error) { serverFailure = error; console.error('Fixture assertion:', error.message); res.writeHead(500).end('{}'); }
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const binary = path.join(temporary, 'test');
    const sources = ['AppleFoundationModel', 'HostAssistantClient', 'ComputerUseTypes', 'ComputerUseMacDriver', 'ComputerUseBrowser', 'ComputerUseController', 'ComputerUseTransport'];
    await execute('xcrun', ['swiftc', '-parse-as-library', '-target', 'arm64-apple-macos13.0', ...sources.map(s => path.join(root, `packaging/macos/${s}.swift`)), path.join(root, 'packaging/macos/validation/ComputerUseHarness.swift'), '-o', binary], { maxBuffer: 1024 * 1024 });
    const fixtureApp = path.join(temporary, 'Computer Use Fixture.app');
    await mkdir(path.join(fixtureApp, 'Contents/MacOS'), { recursive: true });
    await writeFile(path.join(fixtureApp, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>solutions.pleiades.ComputerFixture</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleName</key><string>Computer Use Fixture</string></dict></plist>`);
    await execute('xcrun', ['swiftc', '-parse-as-library', path.join(root, 'packaging/macos/validation/ComputerUseFixtureApp.swift'), '-o', path.join(fixtureApp, 'Contents/MacOS/Fixture')]);
    const pidFile = path.join(temporary, 'fixture.pid');
    await execute('open', ['-n', fixtureApp, '--args', pidFile]);
    const { stdout } = await execute(binary, [String(server.address().port), 'native'], { timeout: 90000, maxBuffer: 1024 * 1024 });
    fixturePID = Number(await readFile(pidFile, 'utf8'));
    if (serverFailure) throw serverFailure;
    assert.match(stdout, /PASS real WebKit/); assert.equal(turns, 4); assert.equal(verified, true);
    console.log(stdout.trim());
  } finally {
    if (!fixturePID) { try { fixturePID = Number(await readFile(path.join(temporary, 'fixture.pid'), 'utf8')); } catch {} }
    if (Number.isInteger(fixturePID) && fixturePID > 0) { try { process.kill(fixturePID, 'SIGTERM'); } catch {} }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});
