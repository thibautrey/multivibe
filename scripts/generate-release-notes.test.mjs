import test from 'node:test';
import assert from 'node:assert/strict';
import { bounded, compareTags, downloads, generateSummary, previousRelease } from './generate-release-notes.mjs';

const release = (tag_name, extra = {}) => ({ tag_name, draft: false, prerelease: false, ...extra });
test('baseline excludes drafts, future releases, other families, prereleases and unrelated history', () => {
  const releases = [release('v1.9.0'), release('v1.10.0'), release('v1.11.0-rc.1', { prerelease: true }), release('v1.11.0'), release('v1.12.0'), release('source-v1.10.1'), release('v1.10.2', { draft: true }), release('v1.10.1')];
  assert.equal(previousRelease(releases, 'v1.11.0', tag => tag !== 'v1.10.1'), 'v1.10.0');
  assert.equal(previousRelease(releases, 'source-v1.11.0', () => true), 'source-v1.10.1');
  assert.equal(previousRelease(releases, 'v1.11.0-rc.2', () => true), 'v1.11.0-rc.1');
  assert.equal(previousRelease(releases, 'v0.1.0', () => true), undefined);
  assert.ok(compareTags('v1.0.0-rc.10', 'v1.0.0-rc.2') > 0);
  assert.ok(compareTags('v1.0.0', 'v1.0.0-rc.10') > 0);
});
test('downloads link to existing platforms, multipart files, installers and checksums only', () => {
  const body = downloads(['multivibe-host_1.2.0_darwin_arm64.dmg', 'multivibe-host_1.2.0_windows_amd64_setup.exe', 'multivibe-host_1.2.0_linux_amd64.tar.gz.part-001', 'multivibe-host_1.2.0_linux_amd64.tar.gz.part-002', 'multivibe-host_1.2.0_linux_amd64.tar.gz.asc', 'SHA256SUMS', 'NATIVE-MULTIPART.txt'], 'owner/repo', 'v1.2.0');
  assert.match(body, /Apple Silicon/);
  assert.match(body, /Installer/);
  assert.match(body, /Part 001/);
  assert.match(body, /Part 002/);
  assert.match(body, /reconstruction instructions/);
  assert.doesNotMatch(body, /Windows ARM|Linux ARM|\.tar.gz.asc/);
  assert.match(body, /https:\/\/github.com\/owner\/repo\/releases\/download\/v1.2.0\//);
  assert.match(downloads(['source.tar.gz'], 'owner/repo', 'source-v1.0.0'), /Source archive/);
});
const env = { RELEASE_NOTES_API_BASE_URL: 'https://example.com/v1/', RELEASE_NOTES_API_KEY: 'test-key', RELEASE_NOTES_MODEL: 'configured-model' };
test('uses configured OpenAI-compatible endpoint and bounds context', async () => {
  const result = await generateSummary({ patch: 'evidence' }, env, async (url, options) => {
    assert.equal(url, 'https://example.com/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.model, env.RELEASE_NOTES_MODEL);
    assert.match(body.messages[1].content, /evidence/);
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'Improved connection recovery for workers.' } }] }) };
  });
  assert.match(result, /Improved/);
  assert.match(bounded('a'.repeat(100), 10), /truncated/);
});
test('rejects missing config, unsafe URLs, errors, empty, truncated and linked AI output', async () => {
  await assert.rejects(generateSummary({}, {}), /configuration/);
  await assert.rejects(generateSummary({}, { ...env, RELEASE_NOTES_API_BASE_URL: 'http://example.com' }), /HTTPS/);
  await assert.rejects(generateSummary({}, env, async () => ({ ok: false, status: 429 })), /429/);
  for (const [finish_reason, content] of [['length', 'Partial notes that should be discarded'], ['stop', ''], ['stop', '[Download](https://invented.example.com)']]) {
    await assert.rejects(generateSummary({}, env, async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason, message: { content } }] }) })), /Invalid/);
  }
});

test('CLI reports optional generation failure without leaving a notes file', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { execFileSync } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'release-notes-test-'));
  const command = (name, args, options = {}) => execFileSync(name, args, { cwd: root, encoding: 'utf8', ...options });
  try {
    await mkdir(join(root, 'bin'));
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets', 'multivibe-host_1.1.0_darwin_arm64.dmg'), 'fixture');
    await writeFile(join(root, 'extra.md'), '## Container\n\nVerified container instructions.');
    await writeFile(join(root, 'bin', 'gh'), `#!/usr/bin/env node\nconst args = process.argv.slice(2);\nconsole.log(JSON.stringify(args.includes('--paginate') ? (process.env.FIRST_RELEASE ? [[]] : [[{tag_name:'v1.0.0',draft:false,prerelease:false}]]) : {body:'## Changes\\n\\n- Fix reconnect (#12)'}));\n`, { mode: 0o755 });
    command('git', ['init', '-q']);
    command('git', ['config', 'user.email', 'test@example.com']);
    command('git', ['config', 'user.name', 'Test']);
    await writeFile(join(root, 'code.txt'), 'old\n');
    command('git', ['add', 'code.txt']);
    command('git', ['commit', '-qm', 'Initial implementation']);
    command('git', ['tag', 'v1.0.0']);
    await writeFile(join(root, 'code.txt'), 'new\n');
    command('git', ['commit', '-qam', 'Fix reconnect']);
    command('git', ['tag', 'v1.1.0']);
    for (const first of ['', '1']) {
      assert.throws(() => command(process.execPath, [fileURLToPath(new URL('./generate-release-notes.mjs', import.meta.url)), 'assets', 'notes.md', 'extra.md'], { env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, GITHUB_REF_NAME: 'v1.1.0', GITHUB_REPOSITORY: 'owner/repo', RELEASE_NOTES_API_KEY: '', FIRST_RELEASE: first }, stdio: ['ignore', 'pipe', 'pipe'] }), /Optional release notes generation failed/);
      await assert.rejects(readFile(join(root, 'notes.md')), { code: 'ENOENT' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('workflows select original notes for failures, timeouts, skipped steps and partial output', async () => {
  const { readFile, mkdtemp, writeFile, rm, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'notes-fallback-test-'));
  try {
    await mkdir(join(root, 'container-release'));
    await writeFile(join(root, 'container-release/container-release-notes.md'), 'Original container instructions');
    for (const workflow of ['provider-host-release.yml', 'source-release.yml']) {
      const text = await readFile(new URL(`../.github/workflows/${workflow}`, import.meta.url), 'utf8');
      assert.match(text, /id: release-notes\n        continue-on-error: true\n        timeout-minutes: 3/u);
      assert.match(text, /RELEASE_NOTES_OUTCOME: \$\{\{ steps.release-notes.outcome \}\}/u);
      const selection = text.match(/          if \[\[ "\$RELEASE_NOTES_OUTCOME"[\s\S]*?          fi/u)[0];
      for (const [outcome, contents] of [['failure', 'partial notes'], ['cancelled', 'partial notes'], ['skipped', ''], ['success', ''], ['success', 'Complete notes']]) {
        await writeFile(join(root, 'release-notes.md'), contents);
        const result = execFileSync('bash', ['-c', `${selection}\nprintf '%s\\n' "\${notes_args[@]}"`], { cwd: root, encoding: 'utf8', env: { ...process.env, RELEASE_NOTES_OUTCOME: outcome } });
        if (outcome === 'success' && contents) assert.match(result, /--notes-file\nrelease-notes.md/u);
        else {
          assert.doesNotMatch(result, /--notes-file/u);
          assert.match(result, workflow.startsWith('provider') ? /Original container instructions\n--generate-notes/u : /Immutable Apache-2.0 source release/u);
        }
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
