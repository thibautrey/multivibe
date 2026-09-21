import { mkdtemp, readFile, readdir, writeFile, rm, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const run = (program, args) => execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Kept identical for release packaging and local signed-app verification.
export async function buildMacOSNative({ binary, resources, architecture = 'arm64', minimum = '13.0' }) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'multivibe-native-'));
  try {
    const developer = process.env.DEVELOPER_DIR || run('xcode-select', ['-p']);
    const toolchain = path.join(developer, 'Toolchains/XcodeDefault.xctoolchain');
    const sdk = run('xcrun', ['--sdk', 'macosx', '--show-sdk-path']);
    const version = run('xcodebuild', ['-version']).split(/\s+/u).at(-1);
    const sourceDirectory = path.join(repository, 'packaging/macos');
    const sources = (await readdir(sourceDirectory)).filter(name => name.endsWith('.swift')).sort().map(name => path.join(sourceDirectory, name));
    const definition = JSON.parse(await readFile(path.join(toolchain, 'usr/share/swift/SwiftConstantValues/AppIntents.json'), 'utf8'));
    const protocols = path.join(temporary, 'protocols.json');
    await writeFile(protocols, JSON.stringify(Array.isArray(definition) ? definition : definition.constValueProtocols));
    const constants = path.join(temporary, 'Host.swiftconstvalues');
    const target = `${architecture}-apple-macos${minimum}`;
    run('xcrun', ['swiftc', '-parse-as-library', '-O', '-whole-module-optimization', '-module-name', 'MultiVibeHost', '-target', target,
      '-emit-const-values-path', constants, '-const-gather-protocols-list', protocols, ...sources, '-o', binary]);
    const sourceList = path.join(temporary, 'sources');
    const constantList = path.join(temporary, 'constants');
    await writeFile(sourceList, `${sources.join('\n')}\n`);
    await writeFile(constantList, `${constants}\n`);
    const contents = path.dirname(resources);
    const appInfo = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(contents, 'Info.plist')]);
    const info = JSON.parse(appInfo);
    const output = run('xcrun', ['appintentsmetadataprocessor', '--output', resources, '--toolchain-dir', toolchain,
      '--module-name', 'MultiVibeHost', '--bundle-identifier', info.CFBundleIdentifier, '--binary-file', binary,
      '--compile-time-extraction', '--deployment-aware-processing', '--no-app-shortcuts-localization', '--sdk-root', sdk, '--xcode-version', version, '--platform-family', 'macOS',
      '--deployment-target', minimum, '--target-triple', target, '--source-file-list', sourceList, '--swift-const-vals-list', constantList]);
    console.log(output);
    await stat(path.join(resources, 'Metadata.appintents', 'extract.actionsdata'));
    const extension = path.join(contents, 'PlugIns', 'MultiVibeShare.appex', 'Contents');
    await mkdir(path.join(extension, 'MacOS'), { recursive: true });
    const template = await readFile(path.join(sourceDirectory, 'share/Info.plist'), 'utf8');
    await writeFile(path.join(extension, 'Info.plist'), template
      .replaceAll('__MULTIVIBE_VERSION__', info.CFBundleShortVersionString)
      .replaceAll('__MULTIVIBE_BUILD__', info.CFBundleVersion));
    run('xcrun', ['swiftc', '-parse-as-library', '-application-extension', '-Xlinker', '-e', '-Xlinker', '_NSExtensionMain', '-O', '-module-name', 'MultiVibeShare',
      '-target', target, path.join(sourceDirectory, 'share/ShareViewController.swift'),
      '-o', path.join(extension, 'MacOS/MultiVibeShare')]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [binary, resources, architecture] = process.argv.slice(2);
  if (!binary || !resources) throw new Error('Usage: build-macos-native.mjs <binary> <resources> [architecture]');
  await buildMacOSNative({ binary, resources, architecture });
}
