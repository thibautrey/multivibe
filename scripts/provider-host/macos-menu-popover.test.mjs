import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

test('native menu popover keeps usage-first spacing and bounded extension widgets', { skip: process.platform !== 'darwin', timeout: 60000 }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'multivibe-menu-popover-'));
  try {
    const binary = path.join(temporary, 'test');
    const sources = [
      'MenuBarLayoutMetrics.swift',
      'MenuBarPalette.swift',
      'MenuBarViews.swift',
      'MenuBarFormatting.swift',
      'MenuBarModels.swift',
      'HostPopoverController.swift',
      'HostPopoverController+Layout.swift',
      'validation/HostPopoverLayoutHarness.swift',
    ].map((file) => path.join(root, 'packaging/macos', file));
    const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    await execute('xcrun', ['swiftc', '-parse-as-library', '-target', `${architecture}-apple-macos13.0`, ...sources, '-o', binary]);
    const { stdout } = await execute(binary);
    assert.match(stdout, /PASS macOS menu popover layout and extension widgets/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
