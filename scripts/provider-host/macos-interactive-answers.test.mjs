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

test('native interactive answers parse persisted messages and run isolated working controls in WebKit', { skip: process.platform !== 'darwin', timeout: 90000 }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'multivibe-interactive-answers-'));
  try {
    const binary = path.join(temporary, 'test');
    await execute('xcrun', ['swiftc', '-parse-as-library',
      ...['NativeInteractiveDocument.swift', 'NativeInteractiveAnswerView.swift', 'validation/NativeInteractiveAnswersHarness.swift'].map(file => path.join(root, 'packaging/macos', file)),
      '-o', binary]);
    const { stdout } = await execute(binary, [], { timeout: 45000 });
    assert.match(stdout, /PASS parser, persistence, working calculator, opaque origin, network isolation, native bridge/);
    console.log(stdout.trim());
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
