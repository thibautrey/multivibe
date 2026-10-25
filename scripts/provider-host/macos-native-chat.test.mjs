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

test('native chat preserves local history and isolates generation from navigation', { skip: process.platform !== 'darwin', timeout: 60000 }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'multivibe-native-chat-test-'));
  try {
    const binary = path.join(temporary, 'test');
    await execute('xcrun', ['swiftc', '-parse-as-library', path.join(root, 'packaging/macos/NativeChatStore.swift'), path.join(root, 'packaging/macos/NativeInteractiveDocument.swift'), path.join(root, 'packaging/macos/validation/DesktopAgentStub.swift'), path.join(root, 'packaging/macos/validation/NativeChatStoreHarness.swift'), '-o', binary]);
    const { stdout } = await execute(binary);
    assert.match(stdout, /PASS history persistence/);
    console.log(stdout.trim());
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('native file imports preserve ordered drafts and reject unsupported or oversized files', { skip: process.platform !== 'darwin', timeout: 60000 }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'multivibe-file-import-test-'));
  try {
    const binary = path.join(temporary, 'test');
    await execute('xcrun', ['swiftc', '-parse-as-library', path.join(root, 'packaging/macos/NativeChatFileImport.swift'), path.join(root, 'packaging/macos/validation/NativeChatFileImportHarness.swift'), '-o', binary]);
    const { stdout } = await execute(binary);
    assert.match(stdout, /PASS ordered multi-file import/);
    console.log(stdout.trim());
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
