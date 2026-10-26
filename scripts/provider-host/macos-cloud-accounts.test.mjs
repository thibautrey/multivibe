import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
const scenarios = [
  {
    name: 'native Cloud accounts preserve migration, PIN locks and account isolation across late token rotation',
    sources: [
      'packaging/macos/NativeCloudSession.swift',
      'packaging/macos/validation/NativeCloudSessionHarness.swift',
    ],
    success: /NativeCloudSession: PKCE\/callback, verified identity, migration, multi-account\/PIN\/lock and late rotation checks passed/,
  },
  {
    name: 'desktop identity resets inactivity on input and preserves PIN and appearance boundaries',
    sources: [
      'packaging/macos/NativeCloudSession.swift',
      'packaging/macos/NativeAgentClient.swift',
      'packaging/macos/NativeChatAgentCoordinator.swift',
      'packaging/macos/NativeFaceRecognition.swift',
      'packaging/macos/NativeDesktopIdentity.swift',
      'packaging/macos/validation/NativeDesktopIdentityHarness.swift',
    ],
    success: /PASS identity inactivity boundary and reset, locked tokens, per-account Cloud state, PIN and transactional appearance; camera never accessed/,
  },
  {
    name: 'native Cloud coordinator preserves durable account journals and rejects work after logout',
    sources: [
      'packaging/macos/NativeCloudSession.swift',
      'packaging/macos/NativeAgentClient.swift',
      'packaging/macos/NativeChatAgentCoordinator.swift',
      'packaging/macos/validation/NativeChatAgentCoordinatorHarness.swift',
    ],
    success: /NativeChatAgentCoordinator: explicit import, durable retries, downward sync, Cloud run\/restart\/poll\/cancel, no resolution replay, logout epoch passed/,
  },
];

for (const scenario of scenarios) {
  test(scenario.name, { skip: process.platform !== 'darwin', timeout: 120_000 }, async context => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'multivibe-cloud-accounts-test-'));
    try {
      const binary = path.join(temporary, 'harness');
      await execute('xcrun', [
        'swiftc', '-parse-as-library', '-target', `${architecture}-apple-macos13.0`,
        '-module-cache-path', path.join(temporary, 'module-cache'),
        ...scenario.sources.map(source => path.join(root, source)), '-o', binary,
      ], { cwd: root, signal: context.signal, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
      const { stdout } = await execute(binary, [], {
        cwd: temporary, signal: context.signal, timeout: 25_000, maxBuffer: 1024 * 1024,
      });
      assert.match(stdout, scenario.success);
      console.log(stdout.trim());
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
