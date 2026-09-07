#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export function winget(version, hash) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version) || !/^[a-f0-9]{64}$/u.test(hash)) throw new Error('A stable version and SHA-256 are required');
  const common = {PackageIdentifier:'MultiVibe.Host',PackageVersion:version};
  return {
    'MultiVibe.Host.yaml': {...common,DefaultLocale:'en-US',ManifestType:'version',ManifestVersion:'1.6.0'},
    'MultiVibe.Host.locale.en-US.yaml': {...common,PackageLocale:'en-US',Publisher:'MultiVibe',PublisherUrl:'https://github.com/thibautrey/multivibe',PublisherSupportUrl:'https://github.com/thibautrey/multivibe/issues',PackageName:'MultiVibe Host',PackageUrl:'https://github.com/thibautrey/multivibe',License:'Apache-2.0',ShortDescription:'Local AI model host for NVIDIA GPUs with opt-in provider sharing',Description:'Requires Windows x64 and an NVIDIA GPU with compute capability 7.0+. Installs per user and preserves application data on uninstall.',ManifestType:'defaultLocale',ManifestVersion:'1.6.0'},
    'MultiVibe.Host.installer.yaml': {...common,InstallerType:'inno',Scope:'user',UpgradeBehavior:'install',Installers:[{Architecture:'x64',InstallerUrl:`https://github.com/thibautrey/multivibe/releases/download/v${version}/multivibe-host_${version}_windows_amd64_setup.exe`,InstallerSha256:hash,ProductCode:'{C6F8A97E-8253-4915-A473-8E153C21D96B}_is1',AppsAndFeaturesEntries:[{DisplayName:'MultiVibe Host',Publisher:'MultiVibe',DisplayVersion:version,ProductCode:'{C6F8A97E-8253-4915-A473-8E153C21D96B}_is1'}]}],ManifestType:'installer',ManifestVersion:'1.6.0'},
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, installer, output] = process.argv.slice(2);
  if (!version || !installer || !output || path.basename(installer) !== `multivibe-host_${version}_windows_amd64_setup.exe`) throw new Error('Usage: winget.mjs version signed-installer.exe output-directory');
  if ((await stat(installer)).size === 0) throw new Error('Empty installer');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(installer)) hash.update(chunk);
  const files = winget(version, hash.digest('hex'));
  const folder = path.join(output,'manifests/m/MultiVibe/Host',version);
  await mkdir(folder,{recursive:true});
  for (const [name,value] of Object.entries(files)) await writeFile(path.join(folder,name),JSON.stringify(value,null,2)+'\n');
  console.log(folder);
}
