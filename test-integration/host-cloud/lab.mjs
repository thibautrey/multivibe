#!/usr/bin/env node
// Development installation: real Host launcher/Core, isolated from user installations.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = path.resolve(process.env.MULTIVIBE_LAB_DIR ?? path.join(os.homedir(), '.local/share/multivibe-host-cloud-lab'));
if (root === repo || root.startsWith(repo + '/')) throw new Error('Keep lab state outside the repository');
const bundle = path.join(root, 'bundle');
const data = path.join(root, 'data');
const port = Number(process.env.MULTIVIBE_LAB_PORT ?? 18455);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid lab port');
const origin = `http://127.0.0.1:${port}`;
const command = process.argv[2];
const run = (bin, args, options = {}) => execFileSync(bin, args, { cwd: repo, stdio: 'inherit', ...options });
const environment = { ...process.env, MULTIVIBE_PROVIDER_ACCELERATOR: 'cpu', MULTIVIBE_HOST_DATA_DIR: data,
  MULTIVIBE_HOST_BIND: '127.0.0.1', MULTIVIBE_HOST_PORT: String(port), MULTIVIBE_HOST_PUBLIC_URL: origin };
const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
if (command === 'install') {
  if (fs.existsSync(bundle)) throw new Error('Installation exists; choose a fresh MULTIVIBE_LAB_DIR to rebuild');
  if (!fs.existsSync(path.join(repo, 'node_modules/tsx'))) throw new Error('Install Core dependencies on main first');
  run('git', ['submodule', 'update', '--init', 'modules/security']);
  run('npm', ['run', 'build']);
  const security = path.join(repo, 'modules/security');
  if (!fs.existsSync(path.join(security, 'dist/index.js'))) {
    run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: security });
    run('npm', ['run', 'build'], { cwd: security });
  }
  for (const dir of ['bin', 'app/modules', 'resources/provider', 'runtime/ollama']) fs.mkdirSync(path.join(bundle, dir), { recursive: true });
  for (const item of ['dist', 'web-dist', 'node_modules', 'package.json']) fs.cpSync(path.join(repo, item), path.join(bundle, 'app', item), { recursive: true, dereference: true });
  fs.cpSync(security, path.join(bundle, 'app/modules/security'), { recursive: true, filter: src => !src.endsWith('/.git') });
  fs.copyFileSync(process.execPath, path.join(bundle, 'bin/node'));
  for (const file of ['provider-model-catalog.json', 'provider-host-dependencies.json']) fs.copyFileSync(path.join(repo, 'packaging', file), path.join(bundle, 'resources/provider', file));
  const goImage = 'golang:1.24';
  for (const [source, binary] of [['host/application', 'multivibe-host'], ['host/updater', 'multivibe-host-updater'], ['provider-agent', 'multivibe-provider-agent']]) {
    run('docker', ['run', '--rm', '--user', `${process.getuid()}:${process.getgid()}`, '-e', 'GOCACHE=/tmp/go-cache',
      '-v', `${repo}:/source:ro`, '-v', `${bundle}/bin:/output`, '-w', `/source/${source}`, goImage,
      'go', 'build', '-trimpath', '-o', `/output/${binary}`, '.']);
  }
  fs.writeFileSync(path.join(bundle, 'runtime/ollama/DEVELOPMENT.txt'), 'Cloud connection lab: no bundled Ollama or model weights. Local inference is outside this installation.\n');
  run(path.join(bundle, 'bin/multivibe-host'), ['doctor'], { env: environment });
  write('installation.json', { kind: 'source-development-cloud-only', coreCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    nodeVersion: process.version, goImage, origin, installedAt: new Date().toISOString() });
  console.log(`Installed development Host at ${bundle}`);
} else if (command === 'start') {
  try { const r = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) }); if (r.ok) throw new Error('Port already serves a Host; inspect status instead'); }
  catch (error) { if (error.message.includes('Port already')) throw error; }
  const log = fs.openSync(path.join(root, 'host.log'), 'a', 0o600);
  const child = spawn(path.join(bundle, 'bin/multivibe-host'), ['run'], { cwd: bundle, env: environment, detached: true, stdio: ['ignore', log, log] });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  write('process.json', { pid: child.pid, origin });
  child.unref(); fs.closeSync(log);
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error(`Host did not become ready; inspect ${root}/host.log locally`);
  console.log(`Host ready: ${origin}`);
} else if (command === 'status') {
  const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(3000) });
  console.log(JSON.stringify({ origin, healthStatus: response.status, installation: JSON.parse(fs.readFileSync(path.join(root, 'installation.json'))) }, null, 2));
} else {
  throw new Error('Usage: node test-integration/host-cloud/lab.mjs install|start|status');
}
