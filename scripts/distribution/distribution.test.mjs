import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checksums, generate, releaseInputs } from './generate.mjs';
import { winget } from './winget.mjs';
import { createContainerReleaseMetadata } from '../provider-host/provider-host-container-release.mjs';
const metadata = createContainerReleaseMetadata('ghcr.io/thibautrey/multivibe-host','1.2.3',`sha256:${'a'.repeat(64)}`,'b'.repeat(40));
const sums = `${'c'.repeat(64)}  multivibe-host_1.2.3_darwin_arm64.dmg\n${'d'.repeat(64)}  multivibe-host_1.2.3_darwin_amd64.dmg\n`;
test('release input rejects duplicates, prereleases and mismatched image identity', () => {
  assert.throws(() => checksums(sums+sums), /duplicate/);
  assert.equal(releaseInputs(metadata,sums.split('\n')[0]).size, 1);
  assert.throws(() => releaseInputs({...metadata,immutableReference:'docker.io/other/app:latest'},sums));
  const beta = createContainerReleaseMetadata(metadata.image,'1.2.3-beta.1',metadata.digest,metadata.sourceCommit);
  assert.throws(() => releaseInputs(beta,sums), /stable/);
});
test('generated packages preserve release identity and platform-specific install settings', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(),'multivibe-distribution-test-'));
  try {
    await generate(metadata,sums,folder);
    const cask = await readFile(path.join(folder,'homebrew/Casks/multivibe-host.rb'),'utf8');
    assert.ok(cask.includes('c'.repeat(64))); assert.ok(cask.includes('d'.repeat(64)));
    assert.match(cask, /auto_updates true/);
    for (const name of ['casaos/Apps/MultiVibeHost/docker-compose.yml','truenas/docker-compose.custom.yml']) {
      const config = JSON.parse(await readFile(path.join(folder,name),'utf8'));
      const host = config.services['multivibe-host'];
      assert.equal(host.image, `${metadata.versionTag}@${metadata.digest}`);
      assert.equal(host.platform,'linux/amd64'); assert.equal(host.read_only,true);
      assert.deepEqual(host.cap_drop,['ALL']); assert.ok(!host.privileged);
      assert.ok(!JSON.stringify(host).includes('docker.sock'));
      assert.ok(host.volumes.some(v=>v.endsWith(':/data'))); assert.ok(host.volumes.some(v=>v.endsWith(':/models')));
      if (config['x-casaos']) {
        assert.equal(host.environment.MULTIVIBE_HOST_PUBLIC_URL,'');
        assert.equal(host.runtime,'nvidia');
        assert.deepEqual(config['x-casaos'].architectures,['amd64']);
      } else assert.match(host.environment.MULTIVIBE_HOST_PUBLIC_URL,/\:\?/);
    }
    const app = JSON.parse(await readFile(path.join(folder,'truenas/multivibe-host/app.yaml'),'utf8'));
    assert.equal(app.app_version, metadata.version);
  } finally { await rm(folder,{recursive:true,force:true}); }
});
test('WinGet binds one stable version to the complete installer bytes and user scope', () => {
  const files = winget('1.2.3','e'.repeat(64));
  const installer = files['MultiVibe.Host.installer.yaml'];
  assert.equal(installer.Scope,'user'); assert.equal(installer.InstallerType,'inno');
  assert.equal(installer.Installers[0].InstallerSha256,'e'.repeat(64));
  assert.match(installer.Installers[0].InstallerUrl,/v1\.2\.3\/multivibe-host_1\.2\.3_windows_amd64_setup\.exe$/);
  assert.throws(()=>winget('1.2.3-beta','e'.repeat(64)), /stable/);
  assert.throws(()=>winget('1.2.3','bad'), /SHA-256/);
});


test('partial releases generate container packages without publishing a broken Homebrew cask', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(),'multivibe-partial-distribution-test-'));
  try {
    const files = await generate(metadata, `${'e'.repeat(64)}  multivibe-host_1.2.3_linux_amd64.tar.gz\n`, folder);
    assert.ok(files.every(name => !name.includes('homebrew')));
    assert.ok(files.some(name => name.includes('truenas')));
    await assert.rejects(readFile(path.join(folder, 'homebrew/Casks/multivibe-host.rb')), {code: 'ENOENT'});
  } finally { await rm(folder,{recursive:true,force:true}); }
});
