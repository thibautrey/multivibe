import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const cefVersion = '156.0.14+g4fa4ab5+chromium-156.0.8078.48';
export const cefArtifacts = Object.freeze({
  arm64: { platform: 'macosarm64', sha256: 'ed994b907ad596ca609a0542a1e2b22aa97e93e98b8141fed4c24aef39b9ccf6' },
  x86_64: { platform: 'macosx64', sha256: 'e584ade521802f8c2779d24996b32ddc183e8502743e5e3910b7247bb08f24f1' },
});
const encodedVersion = cefVersion.replaceAll('+', '%2B');
const run = (program, args, options = {}) => execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();

function targetArchitecture(value) {
  if (value === 'arm64') return 'arm64';
  if (value === 'amd64' || value === 'x64' || value === 'x86_64') return 'x86_64';
  throw new Error(`CEF supports only macOS arm64 or x86_64, received ${value}`);
}
function artifactFor(architecture) {
  const key = targetArchitecture(architecture), artifact = cefArtifacts[key];
  if (!/^[a-f0-9]{64}$/u.test(artifact.sha256)) throw new Error(`CEF ${key} SHA-256 is not configured`);
  const filename = `cef_binary_${cefVersion}_${artifact.platform}_minimal.tar.bz2`;
  return { ...artifact, architecture: key, filename, url: `https://cef-builds.spotifycdn.com/cef_binary_${encodedVersion}_${artifact.platform}_minimal.tar.bz2` };
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function download(url, file) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) });
  if (!response.ok || !response.body) throw new Error(`CEF download failed with HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file, { flags: 'wx', mode: 0o600 }));
}
function safeArchiveEntries(archive) {
  const entries = run('/usr/bin/tar', ['-tjf', archive]).split('\n').filter(Boolean);
  if (!entries.length || entries.length > 30_000) throw new Error('CEF archive has an invalid entry count');
  for (const entry of entries) {
    if (entry.startsWith('/') || entry.includes('\0') || entry.split('/').some(part => part === '..')) throw new Error(`unsafe CEF archive entry: ${entry}`);
  }
}
async function validateSDK(sdk, architecture) {
  const readme = await readFile(path.join(sdk, 'README.txt'), 'utf8');
  if (!readme.includes(`CEF Version:      ${cefVersion}`)) throw new Error('CEF SDK version does not match the pinned version');
  const framework = path.join(sdk, 'Release', 'Chromium Embedded Framework.framework');
  const binary = path.join(framework, 'Chromium Embedded Framework');
  const license = path.join(sdk, 'LICENSE.txt');
  for (const file of [binary, license, path.join(sdk, 'include', 'cef_app.h'), path.join(sdk, 'libcef_dll', 'CMakeLists.txt')]) {
    if (!existsSync(file)) throw new Error(`CEF SDK is incomplete: ${file}`);
  }
  const arches = run('/usr/bin/lipo', ['-archs', binary]).split(/\s+/u);
  if (!arches.includes(architecture)) throw new Error(`CEF framework architecture mismatch: ${arches.join(', ')}`);
  return { framework, license };
}
async function locateSDK(root) {
  const names = (await readdir(root)).filter(name => name.startsWith(`cef_binary_${cefVersion}+`) || name.startsWith(`cef_binary_${cefVersion}_`) || name.startsWith('cef_binary_'));
  if (names.length !== 1) throw new Error(`CEF extraction must contain exactly one SDK directory, found ${names.length}`);
  return path.join(root, names[0]);
}
export async function ensureCefSDK(architecture, options = {}) {
  const artifact = artifactFor(architecture);
  if (process.env.MULTIVIBE_CEF_SDK_DIR) {
    const sdk = path.resolve(process.env.MULTIVIBE_CEF_SDK_DIR);
    await validateSDK(sdk, artifact.architecture);
    return { sdk, artifact };
  }
  const cacheRoot = path.resolve(options.cacheRoot ?? process.env.MULTIVIBE_CEF_CACHE_DIR ?? path.join(homedir(), 'Library', 'Caches', 'MultiVibe', 'cef'));
  const target = path.join(cacheRoot, `${artifact.platform}-${artifact.sha256.slice(0, 16)}`);
  const marker = path.join(target, '.multivibe-cef.json');
  if (existsSync(marker)) {
    const sdk = await locateSDK(target); await validateSDK(sdk, artifact.architecture); return { sdk, artifact };
  }
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(cacheRoot, '.extract-'));
  try {
    const archive = path.join(staging, artifact.filename);
    await download(artifact.url, archive);
    const actual = await digest(archive);
    if (actual !== artifact.sha256) throw new Error(`CEF SHA-256 mismatch: expected ${artifact.sha256}, got ${actual}`);
    safeArchiveEntries(archive);
    run('/usr/bin/tar', ['-xjf', archive, '-C', staging]);
    await rm(archive);
    const sdk = await locateSDK(staging); await validateSDK(sdk, artifact.architecture);
    await writeFile(path.join(staging, '.multivibe-cef.json'), `${JSON.stringify({ version: cefVersion, architecture: artifact.architecture, sha256: artifact.sha256 })}\n`, { mode: 0o400 });
    try { await rename(staging, target); } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
    }
  } finally {
    if (existsSync(staging)) await rm(staging, { recursive: true, force: true });
  }
  const sdk = await locateSDK(target); await validateSDK(sdk, artifact.architecture); return { sdk, artifact };
}
async function wrapperLibrary(sdk, architecture) {
  const build = path.join(sdk, '.multivibe-build', architecture);
  const library = path.join(build, 'libcef_dll_wrapper', 'libcef_dll_wrapper.a');
  if (existsSync(library)) return library;
  await mkdir(build, { recursive: true });
  run('cmake', ['-S', sdk, '-B', build, '-G', 'Ninja', `-DPROJECT_ARCH=${architecture}`, '-DCMAKE_BUILD_TYPE=Release']);
  run('cmake', ['--build', build, '--target', 'libcef_dll_wrapper', '--parallel', '6']);
  if (!existsSync(library)) throw new Error('CEF wrapper library was not produced');
  return library;
}
function helperInfo() {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>CFBundleDevelopmentRegion</key><string>fr</string>\n<key>CFBundleDisplayName</key><string>MultiVibe Chromium Helper</string>\n<key>CFBundleExecutable</key><string>MultiVibe Chromium Helper</string>\n<key>CFBundleIdentifier</key><string>cloud.multivibe.host.chromium.helper</string>\n<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>\n<key>CFBundleName</key><string>MultiVibe Chromium Helper</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n<key>CFBundleShortVersionString</key><string>1.0</string>\n<key>CFBundleVersion</key><string>1</string>\n<key>LSBackgroundOnly</key><true/>\n<key>LSMinimumSystemVersion</key><string>13.0</string>\n<key>NSHighResolutionCapable</key><true/>\n</dict></plist>\n`;
}
async function installFramework(source, frameworks) {
  const destination = path.join(frameworks, 'Chromium Embedded Framework.framework');
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
  return destination;
}
export async function buildAndInstallCef({ architecture, contents, temporary, repository }) {
  const { sdk, artifact } = await ensureCefSDK(architecture);
  const wrapper = await wrapperLibrary(sdk, artifact.architecture);
  const bridge = path.join(temporary, 'MultiVibeCEFBridge.o');
  const helper = path.join(temporary, 'MultiVibe Chromium Helper');
  const common = ['-std=c++20', '-mmacosx-version-min=13.0', '-arch', artifact.architecture, `-I${sdk}`];
  run('xcrun', ['clang++', ...common, '-fobjc-arc', '-c', path.join(repository, 'packaging/macos/chromium/MultiVibeCEFBridge.mm'), '-o', bridge]);
  run('xcrun', ['clang++', ...common, path.join(repository, 'packaging/macos/chromium/MultiVibeCEFHelper.cc'), wrapper, '-framework', 'Cocoa', '-o', helper]);
  const frameworks = path.join(contents, 'Frameworks'); await mkdir(frameworks, { recursive: true });
  const framework = await installFramework(path.join(sdk, 'Release', 'Chromium Embedded Framework.framework'), frameworks);
  const helperContents = path.join(frameworks, 'MultiVibe Chromium Helper.app', 'Contents');
  await mkdir(path.join(helperContents, 'MacOS'), { recursive: true });
  await writeFile(path.join(helperContents, 'Info.plist'), helperInfo());
  await copyFile(helper, path.join(helperContents, 'MacOS', 'MultiVibe Chromium Helper'));
  await chmod(path.join(helperContents, 'MacOS', 'MultiVibe Chromium Helper'), 0o555);
  await copyFile(path.join(sdk, 'LICENSE.txt'), path.join(contents, 'Resources', 'ChromiumEmbeddedFramework-LICENSE.txt'));
  return { bridge, wrapper, framework, helperApp: path.dirname(helperContents), artifact };
}
