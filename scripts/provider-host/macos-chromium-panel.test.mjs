import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildAndInstallCef, cefVersion } from './cef-runtime.mjs';
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

test('native right panel embeds pinned Chromium and completes a real CDP browser flow', { skip: process.platform !== 'darwin', timeout: 300000 }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'multivibe-chromium-panel-'));
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Recette Chromium</title><body style="font:24px system-ui;padding:40px"><h1>Recette Chromium ${cefVersion}</h1><label>Votre texte <input aria-label="Votre texte"></label><button onclick="document.getElementById('result').textContent='Chromium confirmé : '+document.querySelector('input').value">Vérifier</button><p id="result">En attente</p><input type="password" value="SECRET-NOT-FOR-MODEL"></body>`);
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const app = path.join(temporary, 'Chromium Panel.app'), contents = path.join(app, 'Contents');
    await mkdir(path.join(contents, 'MacOS'), { recursive: true }); await mkdir(path.join(contents, 'Resources'), { recursive: true });
    const cef = await buildAndInstallCef({ architecture: process.arch, contents, temporary, repository: root });
    await writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>cloud.multivibe.chromium-panel-test</string><key>CFBundleExecutable</key><string>Chromium Panel</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleName</key><string>Chromium Panel</string><key>NSPrincipalClass</key><string>MVCEFApplication</string></dict></plist>`);
    const binary = path.join(contents, 'MacOS', 'Chromium Panel');
    await execute('xcrun', ['swiftc', '-parse-as-library', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`,
      path.join(root, 'packaging/macos/ComputerUseTypes.swift'), path.join(root, 'packaging/macos/ChromiumBrowser.swift'),
      path.join(root, 'packaging/macos/validation/ChromiumPanelHarness.swift'), cef.bridge, cef.wrapper, '-lc++', '-o', binary], { maxBuffer: 2 * 1024 * 1024 });
    await chmod(binary, 0o755);
    await execute('codesign', ['--force', '--deep', '--sign', '-', path.join(contents, 'Frameworks/Chromium Embedded Framework.framework')]);
    const testEntitlements = path.join(temporary, 'test.entitlements');
    await writeFile(testEntitlements, '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>');
    await execute('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', testEntitlements, path.join(contents, 'Frameworks/MultiVibe Chromium Helper.app')]);
    await execute('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', testEntitlements, app]);
    const { stdout } = await execute(binary, [`http://127.0.0.1:${server.address().port}/fixture`], { timeout: 180000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, MULTIVIBE_CHROMIUM_TESTING: '1', MULTIVIBE_CHROMIUM_PROFILE_DIR: path.join(temporary, 'profile') } });
    assert.match(stdout, /PASS real embedded Chromium panel/);
    const png = await readFile('/tmp/MULTIVIBE-138-chromium-panel.png'); assert.ok(png.length > 50_000);
    console.log(stdout.trim());
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});
