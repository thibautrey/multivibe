import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../packaging/macos/face-recognition/', import.meta.url));
const digest = data => createHash('sha256').update(data).digest('hex');
const localFiles = ['index.html', 'engine.js', 'NOTICE.md', 'manifest.json'];
const manifestNames = new Set([
  'face-api.min.js', 'LICENSE.face-api.txt', 'LICENSE.tensorflow.txt', 'LICENSE.tslib.txt', 'LICENSE.dlib-models.txt',
  ...['tiny_face_detector_model', 'face_landmark_68_tiny_model', 'face_recognition_model'].flatMap(name => [
    `models/${name}-weights_manifest.json`, `models/${name}-shard1`,
  ]), 'models/face_recognition_model-shard2',
]);

/** Validate before any download or filesystem mutation. This is also used by offline packaging tests. */
export function validateFaceRecognitionManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || manifest.engine !== 'face-api.js' || manifest.version !== '0.22.2'
      || !/^[a-f0-9]{40}$/.test(manifest.revision) || !Array.isArray(manifest.assets)) throw new Error('Invalid face recognition manifest');
  const seen = new Set();
  for (const asset of manifest.assets) {
    const url = new URL(asset.url);
    if (!manifestNames.has(asset.path) || seen.has(asset.path) || !/^[a-f0-9]{64}$/.test(asset.sha256)
        || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > 8_000_000
        || url.protocol !== 'https:' || url.hostname !== 'raw.githubusercontent.com' || url.search || url.hash
        || !/^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/[a-f0-9]{40}\//.test(url.pathname)) throw new Error('Unsafe face recognition asset');
    seen.add(asset.path);
  }
  if (seen.size !== manifestNames.size) throw new Error('Incomplete face recognition assets');
  return manifest;
}

async function verifiedCached(asset, cache) {
  const file = path.join(cache, asset.sha256);
  try {
    const info = await lstat(file);
    if (info.isFile() && !info.isSymbolicLink()) {
      const data = await readFile(file);
      if (data.length === asset.bytes && digest(data) === asset.sha256) return data;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetch(asset.url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Face recognition asset download failed: HTTP ${response.status}`);
  const chunks = []; let count = 0;
  for await (const chunk of response.body) {
    count += chunk.byteLength;
    if (count > asset.bytes) throw new Error(`Face recognition asset is too large: ${asset.path}`);
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks);
  if (data.length !== asset.bytes || digest(data) !== asset.sha256) throw new Error(`Face recognition hash mismatch: ${asset.path}`);
  const temporary = path.join(cache, `${asset.sha256}.${randomUUID()}.tmp`);
  try { await writeFile(temporary, data, { flag: 'wx' }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
  return data;
}

/** Bundle offline-only models and their notices into an application's Resources directory. */
export async function prepareFaceRecognition({ resources, cache = path.join(homedir(), '.cache/multivibe/face-recognition') } = {}) {
  if (!resources) throw new Error('Application resources directory is required');
  const resourcePath = path.resolve(resources instanceof URL ? fileURLToPath(resources) : resources);
  const manifest = validateFaceRecognitionManifest(JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8')));
  await mkdir(resourcePath, { recursive: true });
  // Reject a pre-existing symlink: packaging must never follow a destination outside Resources.
  const destination = path.join(resourcePath, 'FaceRecognition');
  try {
    const info = await lstat(destination);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Unsafe FaceRecognition destination');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(cache, { recursive: true });
  const staged = path.join(await realpath(resourcePath), `.FaceRecognition-${randomUUID()}`);
  await mkdir(path.join(staged, 'models'), { recursive: true });
  try {
    for (const asset of manifest.assets) await writeFile(path.join(staged, asset.path), await verifiedCached(asset, cache));
    for (const name of localFiles) await writeFile(path.join(staged, name), await readFile(path.join(source, name)));
    // The weight manifests may refer only to the verified shards included above.
    for (const asset of manifest.assets.filter(item => item.path.endsWith('-weights_manifest.json'))) {
      const weights = JSON.parse(await readFile(path.join(staged, asset.path), 'utf8'));
      for (const group of weights) for (const shard of group.paths) {
        if (shard.includes('/') || !manifestNames.has(`models/${shard}`)) throw new Error('Unsafe model shard reference');
      }
    }
    await rm(destination, { recursive: true, force: true });
    await rename(staged, destination);
  } finally { await rm(staged, { recursive: true, force: true }); }
  return { directory: destination, version: manifest.version, files: manifest.assets.length + localFiles.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const resources = process.argv[2];
  console.log(JSON.stringify(await prepareFaceRecognition({ resources })));
}
