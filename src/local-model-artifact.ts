import type { OpenModel } from './open-model-ranking.js';

/** Metadata identity only. This is not a fit estimate or permission to download.
 * The runtime still must validate architecture/resources and verify downloaded bytes.
 * Only an explicit, single GGUF file is supported here; shards need a bundle quote.
 */
export function pinnedLocalArtifact(model: OpenModel, filename: string) {
  if (model.gated) throw Error('model_access_required');
  if (!/^[\w.-]+\/[\w.-]+$/u.test(model.id) || !model.revision || !/^[a-f0-9]{40}$/u.test(model.revision)) throw Error('artifact_revision_unknown');
  const matches = model.files.filter(file => file.name === filename);
  if (matches.length !== 1 || !filename.endsWith('.gguf') || /-\d{5}-of-\d{5}\.gguf$/u.test(filename) ||
      /[\\\x00-\x1f\x7f%?#]/u.test(filename) || filename.split('/').some(part => !part || part === '.' || part === '..')) throw Error('artifact_not_supported');
  const file = matches[0];
  if (!file.sha256 || !/^[a-f0-9]{64}$/u.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes === null || file.bytes <= 0) throw Error('artifact_metadata_unknown');
  return {
    modelId: model.id, revision: model.revision, filename, bytes: file.bytes,
    digest: `sha256:${file.sha256}`,
    url: `https://huggingface.co/${model.id}/resolve/${model.revision}/${filename.split('/').map(encodeURIComponent).join('/')}`,
  };
}
