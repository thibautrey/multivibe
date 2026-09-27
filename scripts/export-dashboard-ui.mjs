#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (repository, args, encoding) => execFileSync('git', ['-C', repository, ...args], { encoding, maxBuffer: 128 * 1024 * 1024 });
const brandNames = new Set(['multivibe-app-icon.svg', 'multivibe-logo-name-dark-outlined.svg', 'multivibe-logo-name-light-outlined.svg']);
function archivePath(source) {
  if (/^packages\/ui\/(?:src\/[^\0]+\.(?:tsx?|css|json)|public\/assets\/[^\0]+|package\.json)$/.test(source)) return source.slice('packages/ui/'.length);
  if (source === 'LICENSE' || source === 'NOTICE') return source;
  if (source.startsWith('assets/brand/favicon/')) return 'public/assets/brand/' + source.slice('assets/brand/favicon/'.length);
  if (source.startsWith('assets/brand/vector/') && brandNames.has(source.split('/').at(-1))) return 'public/assets/brand/' + source.split('/').at(-1);
}
function tar(entries) {
  const blocks = [];
  for (const { path, bytes } of entries) {
    const header = Buffer.alloc(512);
    let name = path, prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const slash = name.lastIndexOf('/'); prefix = name.slice(0, slash); name = name.slice(slash + 1);
    }
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error('Archive path is too long');
    header.write(name, 0, 100); header.write('0000644\0', 100, 8);
    header.write('0000000\0', 108, 8); header.write('0000000\0', 116, 8);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 12);
    header.write('00000000000\0', 136, 12); header.fill(32, 148, 156);
    header.write('0', 156, 1); header.write('ustar\0', 257, 6); header.write('00', 263, 2); header.write(prefix, 345, 155);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
/** Export only immutable Git objects: dirty files and generated public assets cannot enter. */
export function exportDashboardUI({ repository, commit, output }) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('A full 40-character Core commit SHA is required');
  const resolvedCommit = git(repository, ['rev-parse', '--verify', `${commit}^{commit}`], 'utf8').trim();
  if (resolvedCommit !== commit) throw new Error('Commit did not resolve exactly');
  const records = git(repository, ['ls-tree', '-rz', commit, '--', 'packages/ui', 'assets/brand/favicon', 'assets/brand/vector', 'LICENSE', 'NOTICE'], 'utf8').split('\0').filter(Boolean);
  const entries = [];
  for (const record of records) {
    const [metadata, source] = record.split('\t');
    const path = archivePath(source);
    if (!path) continue;
    const [mode, type, object] = metadata.split(' ');
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error(`Only ordinary committed files are exportable: ${source}`);
    const bytes = git(repository, ['cat-file', 'blob', object]);
    entries.push({ path, source, bytes });
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const required of ['src/index.ts', 'src/SharedDashboard.tsx', 'src/App.tsx', 'src/styles.css', 'src/workspace-refresh.css', 'package.json', 'LICENSE', 'NOTICE']) {
    if (!entries.some(entry => entry.path === required)) throw new Error(`Missing shared UI source: ${required}`);
  }
  if (new Set(entries.map(entry => entry.path)).size !== entries.length) throw new Error('Duplicate archive path');
  const manifest = {
    schemaVersion: 1, package: '@multivibe/ui', sourceRepository: 'multivibe', sourceCommit: commit,
    files: entries.map(({ path, source, bytes }) => ({ path, source, bytes: bytes.length, sha256: sha256(bytes) })),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const archive = gzipSync(tar([...entries, { path: 'manifest.json', bytes: manifestBytes }]), { level: 9, mtime: 0 });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, archive);
  writeFileSync(output + '.manifest.json', manifestBytes);
  const lock = { schemaVersion: 1, sourceCommit: commit, archiveSha256: sha256(archive), manifestSha256: sha256(manifestBytes), fileCount: entries.length };
  writeFileSync(output + '.lock.json', JSON.stringify(lock, null, 2) + '\n');
  return lock;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, args) => index % 2 ? pairs : [...pairs, [value, args[index + 1]]], []));
  if (!flags['--output']) throw new Error('Usage: export-dashboard-ui.mjs --commit FULL_SHA --output archive.tar.gz [--repository CORE_REPOSITORY]');
  console.log(JSON.stringify(exportDashboardUI({ repository: flags['--repository'] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'), commit: flags['--commit'], output: resolve(flags['--output']) })));
}
