import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
test('package is a build-free DSH bundle with shared SDK peers and no lifecycle scripts', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(manifest.name, 'dsh-multivibe');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.repository.directory, 'plugins/dsh-multivibe');
  assert.equal(manifest.dependencies, undefined);
  for (const key of ['install', 'postinstall', 'preinstall', 'prepare', 'prepack']) assert.equal(manifest.scripts[key], undefined);
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) assert.match(range, /0\.2\.0-rc\.2/);
  }
  for (const file of manifest.files) assert.ok((await stat(new URL(file, root))).isFile(), file);
  assert.ok((await stat(new URL('lib/index.js', root))).size < 100_000);
  assert.ok((await stat(new URL('lib/client.js', root))).size < 100_000);
  assert.equal(manifest.files.some(file => /src|test|\.env|\.dsh|data/.test(file)), false);
});
test('distribution contains the native loader factory and external Host SDK imports', async () => {
  const client = await readFile(new URL('lib/client.js', root), 'utf8');
  const host = await readFile(new URL('lib/index.js', root), 'utf8');
  assert.match(client, /__ModuleLoader__\.load/);
  assert.match(client, /settings\.plugins\.tab/);
  assert.match(host, /from "@deepseek-ai\/dsh-tools"/);
  assert.match(host, /from "@deepseek-ai\/dsh-credentials"/);
  assert.doesNotMatch(host, /process\.env\.(?:ADMIN_TOKEN|PROXY_API_KEY)/);
  assert.doesNotMatch(host, /\/admin\/|x-admin-token/);
});
