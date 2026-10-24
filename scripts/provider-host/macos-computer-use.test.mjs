import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

test('desktop action policy enforces permissions and validates real native app control', { skip: process.platform !== 'darwin', timeout: 120000 }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'multivibe-native-control-'));
  let fixturePID;
  try {
    try { await execute('pkill', ['-9', '-f', 'multivibe-native-control-.*Native Control Fixture.app/Contents/MacOS/Fixture']); } catch {}
    const binary = path.join(temporary, 'test');
    const sources = ['ComputerUseTypes', 'ComputerUseMacDriver', 'ComputerUseController'];
    await execute('xcrun', ['swiftc', '-parse-as-library', '-target', 'arm64-apple-macos13.0', ...sources.map(s => path.join(root, `packaging/macos/${s}.swift`)),
      path.join(root, 'packaging/macos/validation/ChromiumBrowserStub.swift'), path.join(root, 'packaging/macos/validation/ComputerUseHarness.swift'), '-o', binary]);
    const fixtureApp = path.join(temporary, 'Native Control Fixture.app');
    await mkdir(path.join(fixtureApp, 'Contents/MacOS'), { recursive: true });
    await writeFile(path.join(fixtureApp, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>solutions.pleiades.ComputerFixture</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleName</key><string>Native Control Fixture</string></dict></plist>`);
    await execute('xcrun', ['swiftc', '-parse-as-library', path.join(root, 'packaging/macos/validation/ComputerUseFixtureApp.swift'), '-o', path.join(fixtureApp, 'Contents/MacOS/Fixture')]);
    const pidFile = path.join(temporary, 'fixture.pid');
    await execute('open', ['-n', fixtureApp, '--args', pidFile]);
    const { stdout } = await execute(binary, ['1', 'native'], { timeout: 90000, maxBuffer: 1024 * 1024 });
    fixturePID = Number(await readFile(pidFile, 'utf8'));
    assert.match(stdout, /PASS policy/);
    if (stdout.includes('accessibility=true, screen=true')) assert.match(stdout, /PASS real macOS ScreenCaptureKit/);
    console.log(stdout.trim());
  } finally {
    if (!fixturePID) { try { fixturePID = Number(await readFile(path.join(temporary, 'fixture.pid'), 'utf8')); } catch {} }
    if (Number.isInteger(fixturePID) && fixturePID > 0) { try { process.kill(fixturePID, 'SIGKILL'); } catch {} }
    await rm(temporary, { recursive: true, force: true });
  }
});
