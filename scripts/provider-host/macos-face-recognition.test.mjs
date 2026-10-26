import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareFaceRecognition, validateFaceRecognitionManifest } from './prepare-face-recognition.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const manifestFile = path.join(root, 'packaging/macos/face-recognition/manifest.json');
const sha256 = data => createHash('sha256').update(data).digest('hex');

test('face assets have immutable URLs, hashes, a closed path list and complete licenses', async () => {
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  assert.equal(validateFaceRecognitionManifest(manifest), manifest);
  for (const mutation of [
    value => { value.assets[0].path = '../escape.js'; },
    value => { value.assets[0].url = 'https://example.com/a'.repeat(2); },
    value => { value.assets[0].url = value.assets[0].url.replace(manifest.revision, 'master'); },
    value => { value.assets[0].sha256 = 'a'; },
    value => { value.assets.push(value.assets[0]); },
    value => { value.assets.pop(); },
  ]) {
    const invalid = structuredClone(manifest); mutation(invalid);
    assert.throws(() => validateFaceRecognitionManifest(invalid));
  }
  assert.deepEqual(manifest.assets.filter(item => item.path.startsWith('LICENSE.')).map(item => item.path).sort(),
    ['LICENSE.face-api.txt', 'LICENSE.tensorflow.txt', 'LICENSE.tslib.txt', 'LICENSE.dlib-models.txt'].sort());
});

test('native face inference loads verified bundled models offline and rejects no-face images', { skip: process.platform !== 'darwin', timeout: 180_000 }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'multivibe-face-recognition-'));
  try {
    const bundled = await prepareFaceRecognition({ resources: path.join(temporary, 'Resources') });
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    for (const asset of manifest.assets) {
      const bytes = await readFile(path.join(bundled.directory, asset.path));
      assert.equal(bytes.length, asset.bytes); assert.equal(sha256(bytes), asset.sha256);
    }
    const binary = path.join(temporary, 'FaceRecognitionChecks');
    await execute('xcrun', ['swiftc', '-parse-as-library', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`,
      path.join(root, 'packaging/macos/NativeFaceRecognition.swift'),
      path.join(root, 'packaging/macos/validation/NativeFaceRecognitionHarness.swift'), '-o', binary], { maxBuffer: 2 * 1024 * 1024 });
    const { stdout } = await execute(binary, [bundled.directory], { timeout: 80_000, maxBuffer: 2 * 1024 * 1024 });
    assert.match(stdout, /PASS native face descriptors, ambiguity, temporal votes and real offline WebKit no-face inference/);
    assert.match(stdout, /camera never accessed/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
