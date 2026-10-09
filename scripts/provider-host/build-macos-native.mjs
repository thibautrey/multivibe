import { mkdtemp, readFile, readdir, writeFile, rm, stat, mkdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const run = (program, args, env = process.env) => execFileSync(program, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const swiftConstantValuesRelativePath = 'usr/share/swift/SwiftConstantValues/AppIntents.json';

// The Swift toolchain is selected through DEVELOPER_DIR. `xcode-select -p` can
// name an incomplete installation, so probe full Xcode installations for both
// extraction tools and prefer an available toolchain protocol definition.
function developerDirectories() {
  const candidates = [];
  const add = (value) => {
    if (!value) return;
    const resolved = path.resolve(value);
    if (path.basename(resolved) !== 'Developer') return;
    if (!candidates.includes(resolved)) candidates.push(resolved);
  };
  add(process.env.DEVELOPER_DIR);
  try {
    add(run('xcode-select', ['-p']));
  } catch {
    // A missing or unselected command line tools installation is reported below.
  }
  const applications = '/Applications';
  try {
    for (const entry of readdirSync(applications)) {
      if (!/^Xcode.*\.app$/u.test(entry)) continue;
      add(path.join(applications, entry, 'Contents', 'Developer'));
    }
  } catch {
    // /Applications is expected on every macOS release build host.
  }
  return candidates;
}

const protocolDefinitionPaths = [swiftConstantValuesRelativePath, 'usr/share/swift/const-gather-protocols.json'];
// Older Xcode releases ship the extraction tools without a protocol list.
// These are the protocols used by HostAppIntents.swift (including inherited queries).
const hostConstValueProtocols = ['AppIntent', 'AppEntity', 'EntityQuery', 'EntityStringQuery', 'AppShortcutsProvider'];

export function resolveMacOSDeveloperDirectory(candidates = developerDirectories()) {
  const complete = candidates.filter((developer) => {
    const bin = path.join(developer, 'Toolchains/XcodeDefault.xctoolchain/usr/bin');
    return existsSync(path.join(bin, 'swiftc')) && existsSync(path.join(bin, 'appintentsmetadataprocessor'));
  });
  const selected = complete.find((developer) => protocolDefinitionPaths.some((relative) =>
    existsSync(path.join(developer, 'Toolchains/XcodeDefault.xctoolchain', relative)))) ?? complete[0];
  if (selected) return selected;
  throw new Error(`no macOS developer directory provides swiftc and appintentsmetadataprocessor; inspected ${candidates.join('; ')}; install full Xcode or set DEVELOPER_DIR`);
}

export async function readConstValueProtocols(toolchain) {
  for (const relative of protocolDefinitionPaths) {
    const filename = path.join(toolchain, relative);
    if (!existsSync(filename)) continue;
    const definition = JSON.parse(await readFile(filename, 'utf8'));
    const protocols = Array.isArray(definition) ? definition : definition.constValueProtocols;
    if (!Array.isArray(protocols) || !protocols.length || protocols.some(value => typeof value !== 'string' || !value)) {
      throw new Error(`invalid Swift constant-value protocols: ${filename}`);
    }
    return protocols;
  }
  return hostConstValueProtocols;
}

export function constValueCompilerArguments(frontendHelp, protocols) {
  // Swift versions differ in the name of this frontend-only option.
  const option = ['-const-gather-protocols-list', '-const-gather-protocols-file']
    .find(candidate => new RegExp(`^\\s*${candidate}\\s`, 'mu').test(frontendHelp));
  if (!option) throw new Error('selected Swift frontend cannot extract App Intents constant values; install a compatible full Xcode');
  return ['-Xfrontend', option, '-Xfrontend', protocols];
}

function commandHelp(program, args, env) {
  const result = spawnSync(program, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  // Some Xcode versions print help to stderr and exit with status 1.
  const help = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status !== 0 && !(result.status === 1 && /usage:/iu.test(help))) {
    throw new Error(`could not inspect ${program} ${args.join(' ')}: ${help}`);
  }
  return help;
}

export function appIntentsFileArguments(help, { sources, constants, version, bundleIdentifier }) {
  const supported = new Set(help.match(/--[a-z][a-z-]*/gu) ?? []);
  const required = (candidates, value) => {
    const option = candidates.find(candidate => supported.has(candidate));
    if (!option) throw new Error(`App Intents processor does not support ${candidates.join(' or ')}`);
    return [option, value];
  };
  return [
    ...required(['--source-file-list', '--source-files'], sources),
    ...required(['--swift-const-vals-list', '--swift-const-vals'], constants),
    ...(supported.has('--xcode-version') ? ['--xcode-version', version] : []),
    ...(supported.has('--bundle-identifier') ? ['--bundle-identifier', bundleIdentifier] : []),
    ...(supported.has('--no-app-shortcuts-localization') ? ['--no-app-shortcuts-localization'] : []),
  ];
}

// Kept identical for release packaging and local signed-app verification.
export async function buildMacOSNative({ binary, resources, architecture = 'arm64', minimum = '13.0' }) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'multivibe-native-'));
  try {
    const developer = resolveMacOSDeveloperDirectory();
    const toolchain = path.join(developer, 'Toolchains/XcodeDefault.xctoolchain');
    const env = { ...process.env, DEVELOPER_DIR: developer };
    const selectedRun = (program, args) => run(program, args, env);
    const sdk = selectedRun('xcrun', ['--sdk', 'macosx', '--show-sdk-path']);
    const version = selectedRun('xcodebuild', ['-version']).split(/\s+/u).at(-1);
    const sourceDirectory = path.join(repository, 'packaging/macos');
    const sources = (await readdir(sourceDirectory)).filter(name => name.endsWith('.swift')).sort().map(name => path.join(sourceDirectory, name));
    const protocols = path.join(temporary, 'protocols.json');
    await writeFile(protocols, JSON.stringify(await readConstValueProtocols(toolchain)));
    const constants = path.join(temporary, 'Host.swiftconstvalues');
    const extractionArguments = constValueCompilerArguments(
      selectedRun('xcrun', ['swiftc', '-frontend', '-help-hidden']), protocols);
    const target = `${architecture}-apple-macos${minimum}`;
    selectedRun('xcrun', ['swiftc', '-parse-as-library', '-O', '-whole-module-optimization', '-module-name', 'MultiVibeHost', '-target', target,
      '-emit-const-values-path', constants, ...extractionArguments, ...sources, '-o', binary]);
    const sourceList = path.join(temporary, 'sources');
    const constantList = path.join(temporary, 'constants');
    await writeFile(sourceList, `${sources.join('\n')}\n`);
    await writeFile(constantList, `${constants}\n`);
    const contents = path.dirname(resources);
    const appInfo = selectedRun('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(contents, 'Info.plist')]);
    const info = JSON.parse(appInfo);
    const fileArguments = appIntentsFileArguments(commandHelp('xcrun', ['appintentsmetadataprocessor', '--help'], env),
      { sources: sourceList, constants: constantList, version, bundleIdentifier: info.CFBundleIdentifier });
    const output = selectedRun('xcrun', ['appintentsmetadataprocessor', '--output', resources, '--toolchain-dir', toolchain,
      '--module-name', 'MultiVibeHost', '--binary-file', binary,
      '--compile-time-extraction', '--deployment-aware-processing', '--sdk-root', sdk, '--platform-family', 'macOS',
      '--deployment-target', minimum, '--target-triple', target, ...fileArguments]);
    console.log(output);
    await stat(path.join(resources, 'Metadata.appintents', 'extract.actionsdata'));
    const extension = path.join(contents, 'PlugIns', 'MultiVibeShare.appex', 'Contents');
    await mkdir(path.join(extension, 'MacOS'), { recursive: true });
    const template = await readFile(path.join(sourceDirectory, 'share/Info.plist'), 'utf8');
    await writeFile(path.join(extension, 'Info.plist'), template
      .replaceAll('__MULTIVIBE_VERSION__', info.CFBundleShortVersionString)
      .replaceAll('__MULTIVIBE_BUILD__', info.CFBundleVersion));
    selectedRun('xcrun', ['swiftc', '-parse-as-library', '-application-extension', '-Xlinker', '-e', '-Xlinker', '_NSExtensionMain', '-O', '-module-name', 'MultiVibeShare',
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
