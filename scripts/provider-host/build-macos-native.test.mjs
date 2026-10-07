import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readConstValueProtocols, resolveMacOSDeveloperDirectory } from './build-macos-native.mjs';

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
