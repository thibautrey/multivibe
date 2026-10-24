import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cefArtifacts, cefVersion } from './cef-runtime.mjs';
import { appIntentsFileArguments, commandHelp, constValueCompilerArguments, readConstValueProtocols, resolveMacOSDeveloperDirectory } from './build-macos-native.mjs';

test('Apple processor help is usable when printed to stderr with exit status 255', () => {
  const help = commandHelp(process.execPath, ['-e', 'console.error("USAGE: --source-files <path>"); process.exit(255)'], process.env);
  assert.match(help, /--source-files/u);
  assert.throws(() => commandHelp(process.execPath, ['-e', 'console.error("tool unavailable"); process.exit(1)'], process.env), /could not inspect/u);
});

test('App Intents processor receives the file-list options supported by its Xcode version', () => {
  const inputs = { sources: '/tmp/sources', constants: '/tmp/Host.swiftconstvalues', constantList: '/tmp/constant-files', version: '27A266a', bundleIdentifier: 'cloud.multivibe.host' };
  assert.deepEqual(appIntentsFileArguments('USAGE: --source-files <path> --swift-const-vals <path>', inputs),
    ['--source-files', inputs.sources, '--swift-const-vals', inputs.constants]);
  assert.deepEqual(appIntentsFileArguments('USAGE: --source-file-list <path> --swift-const-vals-list <path> --xcode-version <version> --no-app-shortcuts-localization', inputs),
    ['--source-file-list', inputs.sources, '--swift-const-vals-list', inputs.constantList, '--xcode-version', inputs.version, '--no-app-shortcuts-localization']);
  assert.throws(() => appIntentsFileArguments('USAGE: --source-files <path>', inputs), /--swift-const-vals/u);
});

test('App Intents compiler flags follow the selected Swift frontend capabilities', () => {
  for (const option of ['-const-gather-protocols-list', '-const-gather-protocols-file']) {
    assert.deepEqual(constValueCompilerArguments(`  ${option} <path>\n    Specify protocols`, '/tmp/protocols.json'),
      ['-Xfrontend', option, '-Xfrontend', '/tmp/protocols.json']);
  }
  assert.throws(() => constValueCompilerArguments('  -unrelated-option <path>\n', '/tmp/protocols.json'), /compatible full Xcode/u);
  assert.throws(() => constValueCompilerArguments('description mentions -const-gather-protocols-list', '/tmp/protocols.json'), /compatible full Xcode/u);
});

test('App Intents extraction supports modern, legacy and absent toolchain protocol lists', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'host-xcode-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, relative, definition] of [
    ['modern', 'usr/share/swift/SwiftConstantValues/AppIntents.json', { constValueProtocols: ['AppIntent'] }],
    ['legacy', 'usr/share/swift/const-gather-protocols.json', ['AppIntent', 'AppEntity']],
    ['older', null, null],
  ]) {
    const developer = path.join(root, name, 'Developer');
    const toolchain = path.join(developer, 'Toolchains/XcodeDefault.xctoolchain');
    await mkdir(path.join(toolchain, 'usr/bin'), { recursive: true });
    for (const tool of ['swiftc', 'appintentsmetadataprocessor']) await writeFile(path.join(toolchain, 'usr/bin', tool), '');
    if (relative) {
      await mkdir(path.dirname(path.join(toolchain, relative)), { recursive: true });
      await writeFile(path.join(toolchain, relative), JSON.stringify(definition));
    }
    assert.equal(resolveMacOSDeveloperDirectory([path.join(root, 'incomplete'), developer]), developer);
    const protocols = await readConstValueProtocols(toolchain);
    if (definition) assert.deepEqual(protocols, Array.isArray(definition) ? definition : definition.constValueProtocols);
    else for (const protocol of ['AppIntent', 'AppEntity', 'EntityQuery', 'AppShortcutsProvider']) assert.ok(protocols.includes(protocol));
  }
  assert.throws(() => resolveMacOSDeveloperDirectory([root]), /install full Xcode/u);
  const malformed = path.join(root, 'usr/share/swift/SwiftConstantValues/AppIntents.json');
  await mkdir(path.dirname(malformed), { recursive: true });
  await writeFile(malformed, '{}');
  await assert.rejects(readConstValueProtocols(root), /invalid Swift constant-value protocols/u);
});


test('embedded Chromium archives are revision-bound for both macOS architectures', () => {
  assert.equal(cefVersion, '156.0.14+g4fa4ab5+chromium-156.0.8078.48');
  assert.deepEqual(Object.keys(cefArtifacts).sort(), ['arm64', 'x86_64']);
  for (const artifact of Object.values(cefArtifacts)) {
    assert.match(artifact.platform, /^macos(?:arm64|x64)$/u);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
  }
  assert.notEqual(cefArtifacts.arm64.sha256, cefArtifacts.x86_64.sha256);
});

test('embedded Chromium isolates encrypted storage and enables the macOS sandbox', async () => {
  const bridge = await readFile(new URL('../../packaging/macos/chromium/MultiVibeCEFBridge.mm', import.meta.url), 'utf8');
  const helper = await readFile(new URL('../../packaging/macos/chromium/MultiVibeCEFHelper.cc', import.meta.url), 'utf8');
  assert.match(bridge, /keychain_service_name\) = "MultiVibe Chromium Safe Storage"/u);
  assert.match(bridge, /keychain_account_name\) = "MultiVibe"/u);
  assert.match(helper, /CefScopedSandboxContext sandbox/u);
  assert.match(helper, /sandbox\.Initialize\(argc, argv\)/u);
});

test('provider Host verification requires and architecture-checks Chromium executables', async () => {
  const verifier = await readFile(new URL('./verify-provider-host.mjs', import.meta.url), 'utf8');
  for (const file of [
    'Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework',
    'Frameworks/MultiVibe Chromium Helper.app/Contents/MacOS/MultiVibe Chromium Helper',
  ]) {
    assert.equal(verifier.split(file).length - 1, 2);
  }
  assert.match(verifier, /Resources\/ChromiumEmbeddedFramework-LICENSE\.txt/u);
});
