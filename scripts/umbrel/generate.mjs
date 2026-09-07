import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Input is docker buildx imagetools inspect --format '{{json .Manifest}}'.
// The workflow obtains it from the published index, never from a single image.
export function umbrelPackage(version, descriptor) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^sha256:[a-f0-9]{64}$/.test(descriptor?.digest ?? '') ||
      !['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'].includes(descriptor.mediaType)) {
    throw new Error('A stable version and multiarchitecture index digest are required');
  }
  const platforms = descriptor.manifests?.filter(item => item.platform?.os !== 'unknown') ?? [];
  if (platforms.length !== 2 || !['amd64', 'arm64'].every(arch => platforms.some(item =>
    item.platform?.os === 'linux' && item.platform.architecture === arch && /^sha256:[a-f0-9]{64}$/.test(item.digest)))) {
    throw new Error('The index must contain Linux amd64 and arm64 images');
  }
  const image = `ghcr.io/thibautrey/multivibe-host-umbrel:${version}@${descriptor.digest}`;
  return {
    'docker-compose.yml': {services: {
      app_proxy: {environment: {APP_HOST: 'multivibe-host_server_1', APP_PORT: 1455}},
      server: {image, init: true, restart: 'unless-stopped', read_only: true,
        tmpfs: ['/tmp:rw,nosuid,nodev,noexec,mode=1777,size=512m'],
        cap_drop: ['ALL'], cap_add: ['CHOWN','FOWNER','SETGID','SETUID'],
        security_opt: ['no-new-privileges:true'], stop_grace_period: '45s',
        environment: {MULTIVIBE_PROVIDER_ACCELERATOR: 'cpu', MULTIVIBE_HOST_PUBLIC_URL: 'http://${DEVICE_DOMAIN_NAME}:${APP_PROXY_PORT}'},
        volumes: ['${APP_DATA_DIR}/data:/data','${APP_DATA_DIR}/models:/models']}
    }},
    'umbrel-app.yml': {manifestVersion: 1, id: 'multivibe-host', category: 'ai', name: 'MultiVibe Host', version,
      tagline: 'Run a local AI provider on your Umbrel',
      description: 'CPU hosting for amd64 and ARM64. Start with the reviewed Qwen 2.5 0.5B model and a 2048-token context. 8 GB RAM recommended; model capacity is limited to half of effective system/container memory before your capacity percentage. Model downloads and sharing are opt-in. In browser setup use /models/weights for model storage. Access through the Umbrel local device domain; alternative IP, Tor and reverse-proxy origins require explicit Host configuration.',
      releaseNotes: 'Adds native ARM64 and amd64 CPU runtimes with bounded memory planning and zero GPU offload.',
      developer: 'MultiVibe', website: 'https://multivibe.cloud', dependencies: [], repo: 'https://github.com/thibautrey/multivibe',
      support: 'https://github.com/thibautrey/multivibe/issues', port: 1455, gallery: [], path: '',
      defaultUsername: '', defaultPassword: '', submitter: 'MultiVibe', submission: 'https://github.com/thibautrey/multivibe'}
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [version, input, output] = process.argv.slice(2);
  if (!version || !input || !output) throw new Error('Usage: generate.mjs VERSION INDEX_DESCRIPTOR OUTPUT');
  const files = umbrelPackage(version, JSON.parse(await readFile(input, 'utf8')));
  await mkdir(output, {recursive: true});
  // JSON is a YAML subset and preserves literal Umbrel substitutions.
  for (const [name, value] of Object.entries(files)) await writeFile(resolve(output, name), JSON.stringify(value, null, 2)+'\n');
}
