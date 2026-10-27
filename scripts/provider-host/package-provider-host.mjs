#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { extractPreflightedTarArchive } from "./provider-host-tar-preflight.mjs";
import { pruneProductionNativeDependencies } from "./provider-host-native-dependencies.mjs";
import { runMacStapler } from "./macos-stapler.mjs";
import { buildMacOSNative } from "./build-macos-native.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const downloadHosts = new Set(["nodejs.org", "github.com", "release-assets.githubusercontent.com"]);
const maximumCommandOutputBytes = 64 * 1024 * 1024;
const maximumNodeFileBytes = 512 * 1024 * 1024;
const maximumNodeExtractedBytes = 1024 * 1024 * 1024;
const betterSQLiteSmokeTest = "const Database=require('better-sqlite3');const database=new Database(':memory:');try{const row=database.prepare('SELECT 1 AS value').get();if(row?.value!==1)throw new Error('better-sqlite3 smoke test failed')}finally{database.close()}";
const macOSMinimumVersion = "13.0";
const macOSDiskImageBackground = "dmg-background.png";

export function argumentsFrom(argv) {
  const options = { allowDirty: false, allowUnsigned: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-dirty") options.allowDirty = true;
    else if (argument === "--allow-unsigned") options.allowUnsigned = true;
    else if (["--version", "--output", "--sign-identity", "--notary-profile"].includes(argument)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      options[{
        "--version": "version",
        "--output": "output",
        "--sign-identity": "signIdentity",
        "--notary-profile": "notaryProfile",
      }[argument]] = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!options.version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(options.version)) {
    throw new Error("--version must be a release version without a v prefix");
  }
  if (options.notaryProfile && !options.signIdentity) {
    throw new Error("--notary-profile requires --sign-identity");
  }
  options.output = path.resolve(options.output ?? path.join(repositoryRoot, "release"));
  return options;
}


function target() {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return { key: "darwin-arm64", goos: "darwin", goarch: "arm64", archive: "dmg" };
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return { key: "darwin-amd64", goos: "darwin", goarch: "amd64", archive: "dmg" };
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return { key: "linux-arm64", goos: "linux", goarch: "arm64", archive: "tar.gz" };
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return { key: "linux-amd64", goos: "linux", goarch: "amd64", archive: "tar.gz" };
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return { key: "windows-amd64", goos: "windows", goarch: "amd64", archive: "zip" };
  }
  throw new Error("provider-host packages can be built only on macOS arm64, macOS amd64, Linux amd64/arm64, or Windows amd64");
}

function windowsPowerShellPath() {
  const systemRoot = process.env.SystemRoot?.trim();
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error("SystemRoot is unavailable");
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

async function runWindowsPowerShell(script, variables) {
  const environment = { ...process.env };
  for (const [name, value] of Object.entries(variables)) environment[name] = value;
  await command(windowsPowerShellPath(), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ], { env: environment });
}

export function commandInvocation(program, args, runtime = {}) {
  const platform = runtime.platform ?? process.platform;
  if (platform !== "win32" || program !== "npm") return { program, args };

  const npmExecPath = runtime.npmExecPath ?? process.env.npm_execpath;
  const pathImplementation = platform === "win32" ? path.win32 : path;
  if (!npmExecPath || !pathImplementation.isAbsolute(npmExecPath) ||
    pathImplementation.basename(npmExecPath).toLowerCase() !== "npm-cli.js") {
    throw new Error("npm_execpath must be an absolute path to npm-cli.js on Windows");
  }
  return {
    program: runtime.execPath ?? process.execPath,
    args: [npmExecPath, ...args],
  };
}

export async function command(program, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const invocation = commandInvocation(program, args);
    const child = spawn(invocation.program, invocation.args, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: false,
    });
    let output = "";
    let stderr = "";
    let outputExceeded = false;
    if (options.capture) child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > (options.captureLimit ?? maximumCommandOutputBytes)) {
        outputExceeded = true;
        child.kill("SIGKILL");
      }
    });
    if (options.capture) child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
      if (Buffer.byteLength(stderr) > (options.captureLimit ?? maximumCommandOutputBytes)) {
        outputExceeded = true;
        child.kill("SIGKILL");
      }
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (outputExceeded) reject(new Error(`${program} produced excessive output`));
      else if (code === 0) resolve(output.trim());
      else reject(Object.assign(new Error(`${program} failed with ${signal ?? `exit ${code}`}`), { code, signal, stdout: output, stderr }));
    });
  });
}

async function sha256(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

function validateDependency(name, dependency, expectedArchive) {
  if (!dependency || typeof dependency !== "object" || dependency.archive !== expectedArchive ||
    Object.keys(dependency).sort().join("\0") !== ["archive", "sha256", "url"].join("\0") ||
    typeof dependency.url !== "string" || !/^[a-f0-9]{64}$/u.test(dependency.sha256)) {
    throw new Error(`${name} dependency entry is invalid`);
  }
  const parsed = new URL(dependency.url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || !downloadHosts.has(parsed.hostname)) {
    throw new Error(`${name} dependency URL must be approved credential-free HTTPS`);
  }
  return dependency;
}

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const transientDownloadFailure = (error) => ["TimeoutError", "AbortError"].includes(error.name) ||
  ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"]
    .includes(error.cause?.code ?? error.code);

export async function download(url, destination, expectedSHA256, maximumBytes, {
  fetchDependency = fetch, wait = pause,
} = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || !downloadHosts.has(parsed.hostname)) {
    throw new Error("dependency URL must be credential-free HTTPS");
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let ownsDestination = false;
    try {
      const response = await fetchDependency(parsed, { redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`dependency download failed with HTTP ${response.status}`);
      const finalURL = new URL(response.url);
      if (finalURL.protocol !== "https:" || finalURL.username || finalURL.password || !downloadHosts.has(finalURL.hostname)) {
        throw new Error("dependency download redirected to an unapproved origin");
      }
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (!Number.isSafeInteger(declared) || declared < 0 || declared > maximumBytes) {
        throw new Error("dependency size is invalid or exceeds the package ceiling");
      }
      const file = await open(destination, "wx", 0o600);
      ownsDestination = true;
      const digest = createHash("sha256");
      let received = 0;
      try {
        for await (const chunk of response.body) {
          received += chunk.byteLength;
          if (received > maximumBytes) throw new Error("dependency exceeds the package ceiling");
          digest.update(chunk);
          await file.write(chunk);
        }
        await file.sync();
      } finally {
        await file.close();
      }
      if (declared > 0 && received !== declared) throw new Error("dependency download is truncated");
      if (received < 1) throw new Error("dependency download is empty");
      if (digest.digest("hex") !== expectedSHA256) throw new Error("dependency digest mismatch");
      return;
    } catch (error) {
      // Remove only files created by this attempt, never a pre-existing destination.
      if (ownsDestination) await rm(destination);
      if (!transientDownloadFailure(error) || attempt === 3) {
        throw new Error(`dependency download from ${parsed.hostname} failed (attempt ${attempt}/3): ${error.message}`, { cause: error });
      }
      console.warn(`dependency download from ${parsed.hostname} interrupted; retrying (attempt ${attempt + 1}/3)`);
      await wait(attempt * 1000);
    }
  }
}

async function extractTar(archive, destination, format, profile, maximumFileBytes, maximumExtractedBytes) {
  await extractPreflightedTarArchive(archive, destination, format, {
    profile,
    maximumFileBytes,
    maximumExtractedBytes,
  });
}

async function extractZip(archive, destination) {
  await runWindowsPowerShell(
    "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:MULTIVIBE_PACKAGE_ZIP_SOURCE -DestinationPath $env:MULTIVIBE_PACKAGE_ZIP_DESTINATION -Force",
    {
      MULTIVIBE_PACKAGE_ZIP_SOURCE: archive,
      MULTIVIBE_PACKAGE_ZIP_DESTINATION: destination,
    },
  );
}

async function validateDereferenceableTree(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`dependency archive unexpectedly contains a symlink: ${child}`);
    } else if (entry.isDirectory()) {
      await validateDereferenceableTree(root, child);
    } else if (!entry.isFile()) {
      throw new Error(`dependency archive contains an unsupported entry: ${child}`);
    }
  }
}

async function copySource(source, destination) {
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    filter: (entry) => path.basename(entry) !== ".git",
  });
}

async function buildGo(moduleDirectory, output, versionVariable, version, selectedTarget, packagePath = ".", buildEnvironment = {}) {
  // Match the release workflow: Unix permission fixtures cannot run on Windows.
  await command("go", selectedTarget.goos === "windows"
    ? ["test", "-run", "^$", "./..."]
    : ["test", "./..."], { cwd: moduleDirectory });
  await command("go", [
    "build",
    "-trimpath",
    "-buildvcs=false",
    `-ldflags=-s -w -X main.${versionVariable}=${version}`,
    "-o",
    output,
    packagePath,
  ], {
    cwd: moduleDirectory,
    env: {
      ...process.env,
      CGO_ENABLED: "0",
      GOOS: selectedTarget.goos,
      GOARCH: selectedTarget.goarch,
      ...buildEnvironment,
    },
  });
  await chmod(output, 0o555);
}

async function buildRustEdge(output) {
  await command("cargo", ["build", "-p", "multivibe-v1-edge", "--release"]);
  await cp(path.join(repositoryRoot, "target", "release", "multivibe-v1-edge"), output);
  await chmod(output, 0o555);
}

async function productionApplication(destination, selectedTarget) {
  await mkdir(destination, { recursive: true, mode: 0o755 });
  for (const file of ["package.json", "package-lock.json"]) {
    await cp(path.join(repositoryRoot, file), path.join(destination, file));
  }
  await command("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: destination });
  await pruneProductionNativeDependencies(destination, selectedTarget.key);
  await rm(path.join(destination, "node_modules", ".bin"), { recursive: true, force: true });
  await copySource(path.join(repositoryRoot, "dist"), path.join(destination, "dist"));
  await copySource(path.join(repositoryRoot, "web-dist"), path.join(destination, "web-dist"));
  await mkdir(path.join(destination, "scripts"), { recursive: true, mode: 0o755 });
  for (const file of ["codex-project-hook.mjs", "install-codex-project-hook.mjs", "install-codex-project-hook.sh"]) {
    await cp(path.join(repositoryRoot, "scripts", file), path.join(destination, "scripts", file));
  }
  const nativeSource = path.join(repositoryRoot, "native", "multivibe-proxy-core.node");
  const nativeInfo = await lstat(nativeSource).catch(() => null);
  if (!nativeInfo?.isFile() || nativeInfo.isSymbolicLink()) {
    throw new Error("Rust proxy-core native addon was not built");
  }
  await mkdir(path.join(destination, "native"), { recursive: true, mode: 0o755 });
  await cp(nativeSource, path.join(destination, "native", "multivibe-proxy-core.node"));
  await mkdir(path.join(destination, "modules"), { recursive: true, mode: 0o755 });
  await copySource(path.join(repositoryRoot, "modules", "security"), path.join(destination, "modules", "security"));
  for (const relative of ["multivibe.module.json", path.join("dist", "index.js")]) {
    const source = path.join(destination, "modules", "security", relative);
    const info = await lstat(source).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.size < 1) {
      throw new Error(`bundled Security module is incomplete: ${relative}`);
    }
  }
}

async function nodeRuntime(work, destination, dependency) {
  const archive = path.join(work, dependency.archive === "zip" ? "node.zip" : "node.tar.gz");
  await download(dependency.url, archive, dependency.sha256, 512 * 1024 * 1024);
  const extraction = path.join(work, "node-extracted");
  await mkdir(extraction, { mode: 0o700 });
  if (dependency.archive === "zip") await extractZip(archive, extraction);
  else await extractTar(archive, extraction, dependency.archive, "node-runtime", maximumNodeFileBytes, maximumNodeExtractedBytes);
  await validateDereferenceableTree(extraction);
  const entries = await readdir(extraction, { withFileTypes: true });
  const root = entries.filter((entry) => entry.isDirectory());
  if (entries.length !== 1 || root.length !== 1) throw new Error("Node archive layout is invalid");
  const source = path.join(extraction, root[0].name, dependency.archive === "zip" ? "node.exe" : path.join("bin", "node"));
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error("Node executable layout is invalid");
  await cp(source, destination);
  await chmod(destination, 0o555);
  return path.join(extraction, root[0].name, "LICENSE");
}




async function allFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`release bundles may not contain symlinks: ${child}`);
    if (entry.isDirectory()) files.push(...await allFiles(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`release bundle contains an unsupported entry: ${child}`);
  }
  return files;
}

async function signMacApplication(application, identity) {
  const contents = path.join(application, "Contents");
  const node = path.join(contents, "Frameworks", "node");
  const native = [];
  for (const file of await allFiles(contents)) {
    if (!file.endsWith(".node") && !file.endsWith(".dylib") && !file.endsWith(".so")) continue;
    const handle = await open(path.join(contents, file), "r");
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    await handle.close();
    if (bytesRead !== 4) continue;
    const magic = header.readUInt32BE(0);
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(magic)) {
      native.push(path.join(contents, file));
    }
  }
  // The official Node binary carries the hardened-runtime JIT entitlements it
  // needs to execute JavaScript. Re-signing it as an ordinary nested binary
  // strips those entitlements and makes it terminate with SIGTRAP on launch.
  // Keep its upstream signature, then verify it before sealing the outer app.
  await command("codesign", ["--verify", "--strict", "--verbose=2", node]);
  for (const binary of new Set([
    ...native,
    path.join(contents, "Helpers", "multivibe-host-updater"),
    path.join(contents, "Helpers", "multivibe-v1-edge"),
    path.join(contents, "MacOS", "multivibe-host"),
  ])) {
    await command("codesign", ["--force", "--sign", identity, "--options", "runtime", "--timestamp", binary]);
  }
  const cefFramework = path.join(contents, "Frameworks", "Chromium Embedded Framework.framework");
  const cefHelper = path.join(contents, "Frameworks", "MultiVibe Chromium Helper.app");
  await command("codesign", ["--force", "--sign", identity, "--options", "runtime", "--timestamp", cefFramework]);
  await command("codesign", [
    "--force", "--sign", identity, "--options", "runtime", "--timestamp",
    "--entitlements", path.join(repositoryRoot, "packaging", "macos", "chromium", "ChromiumHelper.entitlements"), cefHelper,
  ]);
  await command("codesign", [
    "--force", "--sign", identity, "--options", "runtime", "--timestamp",
    "--entitlements", path.join(repositoryRoot, "packaging", "macos", "share", "Share.entitlements"),
    path.join(contents, "PlugIns", "MultiVibeShare.appex"),
  ]);
  await command("codesign", [
    "--force", "--sign", identity, "--options", "runtime", "--timestamp",
    "--entitlements", path.join(repositoryRoot, "packaging", "macos", "MultiVibe.entitlements"),
    // Signing the bundle signs CFBundleExecutable after its nested extension is sealed.
    application,
  ]);
  await command("codesign", ["--verify", "--deep", "--strict", "--verbose=2", application]);
  await command(node, ["--eval", betterSQLiteSmokeTest], {
    cwd: path.join(contents, "Resources", "app"),
  });
}

async function createMacApplicationIcon(work, destination) {
  const source = path.join(repositoryRoot, "assets", "brand", "favicon", "favicon-1024.png");
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size < 1024) {
    throw new Error("the official MultiVibe application icon is unavailable");
  }
  const iconset = path.join(work, "MultiVibe.iconset");
  await mkdir(iconset, { mode: 0o700 });
  for (const [name, pixels] of [
    ["icon_16x16.png", 16], ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32], ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128], ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256], ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512], ["icon_512x512@2x.png", 1024],
  ]) {
    await command("sips", ["--resampleHeightWidth", String(pixels), String(pixels), source, "--out", path.join(iconset, name)]);
  }
  await command("iconutil", ["--convert", "icns", "--output", destination, iconset]);
  await chmod(destination, 0o444);
}

const submissionIDPattern = /^\s*id:\s*([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\s*$/imu;
const crashedNotaryClient = (error) => error.signal === "SIGBUS";
// Apple's notary client aborts an in-flight upload when the connection to S3 is
// reset. A SIGBUS crash and a transport abort are both recoverable: with a
// reported submission ID the existing submission is resumed, and without one the
// upload is repeated because Apple never created a submission to resume.
const transientNotaryFailure = (error) => (crashedNotaryClient(error) || /abortedUpload|Connection reset by peer|Network\.NWError|NSURLErrorDomain|The network connection was lost|The request timed out/iu
  .test(`${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.message ?? ""}`));

export async function submitMacNotarization(file, profile, run = command, attempts = 3, wait = pause, keychain = process.env.SIGNING_KEYCHAIN) {
  const credentials = ["--keychain-profile", profile, ...(keychain ? ["--keychain", keychain] : [])];
  let output;
  for (let attempt = 1; ; attempt += 1) {
    try {
      output = await run("xcrun", ["notarytool", "submit", file, ...credentials,
        "--no-wait", "--no-progress", "--no-s3-acceleration"], { capture: true });
      break;
    } catch (error) {
      if (!transientNotaryFailure(error)) throw error;
      output = error.stdout ?? "";
      // An ID is not proof of a completed upload. Only an Accepted response
      // below permits stapling; never blindly resubmit an identified upload.
      if (submissionIDPattern.test(output)) break;
      if (attempt >= attempts) {
        throw new Error(`notarytool submit aborted ${attempts} times without a submission ID: ${error.message}`, { cause: error });
      }
      console.warn(`notarytool submit failed before creating a submission; retrying (attempt ${attempt + 1}/${attempts})`);
      await wait(attempt * 1000);
    }
  }
  const id = output.match(submissionIDPattern)?.[1];
  if (!id) throw new Error("notarytool submit returned no submission ID; notarization cannot be verified");
  console.log(`Notarization submission: ${id}`);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let result;
    try {
      result = await run("xcrun", ["notarytool", "wait", id, ...credentials,
        "--timeout", "15m", "--output-format", "json"], { capture: true });
    } catch (error) {
      if (transientNotaryFailure(error) && attempt < 3) {
        console.warn(`notarytool wait interrupted; resuming submission ${id} (attempt ${attempt + 1}/3)`);
        await wait(attempt * 1000);
        continue;
      }
      throw new Error(`Notarization ${id} could not be verified: ${error.message}`, { cause: error });
    }
    const report = JSON.parse(result);
    if (report.id?.toLowerCase() !== id.toLowerCase() || report.status !== "Accepted") {
      throw new Error(`Notarization ${id} was not accepted (status: ${report.status ?? "missing"})`);
    }
    return id;
  }
}

export async function stapleMacArtifact(file, run = command, wait = pause) {
  await runMacStapler("staple", file, run, wait);
  await runMacStapler("validate", file, run, wait);
}

async function notarizeMacApplication(application, profile, work) {
  const submission = path.join(work, "notary-submission.zip");
  await command("ditto", ["-c", "-k", "--keepParent", application, submission]);
  await submitMacNotarization(submission, profile);
  await stapleMacArtifact(application);
  await command("spctl", ["--assess", "--type", "execute", "--verbose=2", application]);
}

async function notarizeMacDiskImage(diskImage, profile) {
  await submitMacNotarization(diskImage, profile);
  await stapleMacArtifact(diskImage);
  await command("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", diskImage]);
}

async function writeManifest(root, metadata) {
  const files = (await allFiles(root)).sort((left, right) => left.localeCompare(right));
  const entries = [];
  for (const relative of files) {
    if (relative === "manifest.json") continue;
    const file = path.join(root, relative);
    const info = await stat(file);
    entries.push({ path: relative, size: info.size, mode: info.mode & 0o777, sha256: await sha256(file) });
  }
  await writeFile(path.join(root, "manifest.json"), `${JSON.stringify({ ...metadata, files: entries }, null, 2)}\n`, { mode: 0o444 });
}

async function assemble(options, selectedTarget, work, dependencies, sourceCommit, buildNumber, sourceTreeDirty) {
  const baseName = `multivibe-host_${options.version}_${selectedTarget.key.replace("-", "_")}`;
  const root = path.join(work, baseName);
  await mkdir(root, { mode: 0o755 });
  await cp(path.join(repositoryRoot, "LICENSE"), path.join(root, "LICENSE"));
  await cp(path.join(repositoryRoot, "NOTICE"), path.join(root, "NOTICE"));
  await cp(path.join(repositoryRoot, "packaging", "PROVIDER-HOST-README.md"), path.join(root, "README.md"));
  await cp(path.join(repositoryRoot, "packaging", "container", "docker-compose.host.yml"), path.join(root, "docker-compose.host.yml"));
  const installerPlatform = selectedTarget.goos === "darwin" ? "macos" : selectedTarget.goos === "linux" ? "linux" : "windows";
  if (selectedTarget.goos === "windows") {
    for (const script of ["install.ps1", "uninstall.ps1"]) {
      await cp(path.join(repositoryRoot, "packaging", installerPlatform, script), path.join(root, script));
      await chmod(path.join(root, script), 0o444);
    }
  } else {
    for (const script of ["install.sh", "uninstall.sh"]) {
      const destination = path.join(root, script);
      await cp(path.join(repositoryRoot, "packaging", installerPlatform, script), destination);
      await chmod(destination, 0o555);
    }
  }
  if (selectedTarget.goos === "linux") {
    for (const [source, destinationName] of [
      ["install-host-updater.sh", "install-docker-updater.sh"],
      ["uninstall-host-updater.sh", "uninstall-docker-updater.sh"],
    ]) {
      const destination = path.join(root, destinationName);
      await cp(path.join(repositoryRoot, "packaging", "docker", source), destination);
      await chmod(destination, 0o555);
    }
  }
  await mkdir(path.join(root, "THIRD_PARTY"), { mode: 0o755 });
  await cp(path.join(repositoryRoot, "packaging", "provider-host-dependencies.json"), path.join(root, "THIRD_PARTY", "provider-host-dependencies.json"));
  let applicationDirectory;
  let nodeDestination;
  let updaterDestination;
  let hostDestination;
  let edgeDestination;
  let menuDestination;
  let menuBarDestination;
  let resourceDirectory;
  let verifierDestination;
  let macApplication;
  if (selectedTarget.goos === "darwin") {
    macApplication = path.join(root, "MultiVibe Host.app");
    const contents = path.join(macApplication, "Contents");
    applicationDirectory = path.join(contents, "Resources", "app");
    nodeDestination = path.join(contents, "Frameworks", "node");
    updaterDestination = path.join(contents, "Helpers", "multivibe-host-updater");
    hostDestination = path.join(contents, "MacOS", "multivibe-host");
    edgeDestination = path.join(contents, "Helpers", "multivibe-v1-edge");
    menuBarDestination = path.join(contents, "MacOS", "MultiVibe Host");
    resourceDirectory = path.join(contents, "Resources", "provider");
    verifierDestination = path.join(contents, "Resources", "verify-provider-host.mjs");
    for (const directory of [applicationDirectory, path.dirname(nodeDestination), path.dirname(hostDestination), path.dirname(edgeDestination)]) {
      await mkdir(directory, { recursive: true, mode: 0o755 });
    }
    const info = (await readFile(path.join(repositoryRoot, "packaging", "macos", "Info.plist"), "utf8"))
      .replaceAll("__MULTIVIBE_VERSION__", options.version)
      .replaceAll("__MULTIVIBE_BUILD__", buildNumber)
      .replaceAll("__MULTIVIBE_MACOS_MINIMUM_VERSION__", macOSMinimumVersion);
    await writeFile(path.join(contents, "Info.plist"), info);
    await cp(
      path.join(repositoryRoot, "packaging", "macos", "MultiVibeMenuBarTemplate.png"),
      path.join(contents, "Resources", "MultiVibeMenuBarTemplate.png"),
    );
    await cp(
      path.join(repositoryRoot, "packaging", "macos", "resources", "harnesses"),
      path.join(contents, "Resources", "harnesses"),
      { recursive: true },
    );
    await cp(
      path.join(repositoryRoot, "packaging", "macos", "resources", "OpenIntelligentUI-LICENSE.txt"),
      path.join(contents, "Resources", "OpenIntelligentUI-LICENSE.txt"),
    );
    await mkdir(path.join(contents, "Resources", "update"), { recursive: true, mode: 0o755 });
    await cp(
      path.join(repositoryRoot, "packaging", "macos", "install.sh"),
      path.join(contents, "Resources", "update", "install.sh"),
    );
    await chmod(path.join(contents, "Resources", "update", "install.sh"), 0o555);
    await createMacApplicationIcon(work, path.join(contents, "Resources", "MultiVibe.icns"));
  } else {
    applicationDirectory = path.join(root, "app");
    const executableSuffix = selectedTarget.goos === "windows" ? ".exe" : "";
    updaterDestination = path.join(root, "bin", `multivibe-host-updater${executableSuffix}`);
    hostDestination = path.join(root, "bin", `multivibe-host${executableSuffix}`);
    menuDestination = path.join(root, "bin", `multivibe-host-menu${executableSuffix}`);
    nodeDestination = path.join(root, "bin", `node${executableSuffix}`);
    resourceDirectory = path.join(root, "resources", "provider");
    verifierDestination = path.join(root, "verify-provider-host.mjs");
    await mkdir(path.join(root, "bin"), { recursive: true, mode: 0o755 });
    await mkdir(resourceDirectory, { recursive: true, mode: 0o755 });
  }

  await productionApplication(applicationDirectory, selectedTarget);
  await mkdir(resourceDirectory, { recursive: true, mode: 0o755 });
  if (selectedTarget.goos === "linux") {
    await cp(
      path.join(repositoryRoot, "assets", "brand", "favicon", "favicon-32x32.png"),
      path.join(resourceDirectory, "multivibe-host.png"),
    );
  } else if (selectedTarget.goos === "windows") {
    await cp(
      path.join(repositoryRoot, "assets", "brand", "favicon", "favicon.ico"),
      path.join(resourceDirectory, "multivibe-host.ico"),
    );
  }
  await cp(path.join(repositoryRoot, "scripts", "provider-host", "verify-provider-host.mjs"), verifierDestination);
  await chmod(verifierDestination, 0o444);
  const nodeLicense = await nodeRuntime(work, nodeDestination, dependencies.node.artifacts[selectedTarget.key]);
  await cp(nodeLicense, path.join(root, "THIRD_PARTY", "node-LICENSE"));
  await command(nodeDestination, ["--eval", betterSQLiteSmokeTest], { cwd: applicationDirectory });
  await buildGo(path.join(repositoryRoot, "host", "updater"), updaterDestination, "hostUpdaterVersion", options.version, selectedTarget);
  await buildGo(path.join(repositoryRoot, "host", "application"), hostDestination, "hostApplicationVersion", options.version, selectedTarget);
  if (edgeDestination) await buildRustEdge(edgeDestination);
  if (menuDestination) {
    await buildGo(
      path.join(repositoryRoot, "host", "menu"), menuDestination, "menuApplicationVersion", options.version, selectedTarget,
      ".", { CGO_ENABLED: selectedTarget.goos === "linux" ? "1" : "0" },
    );
  }
  if (menuBarDestination) {
    const swiftArchitecture = selectedTarget.goarch === "arm64" ? "arm64" : "x86_64";
    await buildMacOSNative({
      binary: menuBarDestination,
      resources: path.join(macApplication, "Contents", "Resources"),
      architecture: swiftArchitecture,
      minimum: macOSMinimumVersion,
    });
    await chmod(menuBarDestination, 0o555);
  }

  let macOSSignature = null;
  if (macApplication) {
    macOSSignature = options.notaryProfile ? "developer-id-notarized" : options.signIdentity ? "developer-id" : "unsigned-development";
    await writeFile(path.join(macApplication, "Contents", "Resources", "provider-host-release.json"), `${JSON.stringify({
      schemaVersion: 1,
      product: "multivibe-host",
      version: options.version,
      sourceCommit,
      platform: selectedTarget.goos,
      architecture: selectedTarget.goarch,
      sourceTreeDirty,
      releaseReady: !sourceTreeDirty && macOSSignature === "developer-id-notarized",
      macOSSignature,
    }, null, 2)}\n`, { mode: 0o444 });
    if (!options.signIdentity && !options.allowUnsigned) throw new Error("macOS packaging requires --sign-identity");
    if (options.signIdentity) {
      await signMacApplication(macApplication, options.signIdentity);
    }
    if (options.notaryProfile) {
      await notarizeMacApplication(macApplication, options.notaryProfile, work);
    }
    else if (!options.allowUnsigned) throw new Error("macOS packaging requires --notary-profile");
  }

  await writeManifest(root, {
    schemaVersion: 1,
    product: "multivibe-host",
    version: options.version,
    sourceCommit,
    platform: selectedTarget.goos,
    architecture: selectedTarget.goarch,
    sourceTreeDirty,
    releaseReady: !sourceTreeDirty && (selectedTarget.goos !== "darwin" || macOSSignature === "developer-id-notarized"),
    macOSSignature,
    node: dependencies.node,
  });
  await command(process.execPath, [path.join(repositoryRoot, "scripts", "provider-host", "verify-provider-host.mjs"), "--directory", root]);
  return { root, baseName };
}

export async function archiveBundle(bundle, options, selectedTarget) {
  await mkdir(options.output, { recursive: true, mode: 0o755 });
  const extension = selectedTarget.archive;
  const destination = path.join(options.output, `${bundle.baseName}.${extension}`);
  await rm(destination, { force: true });
  if (selectedTarget.archive === "dmg") {
    const diskImageRoot = path.join(path.dirname(bundle.root), "dmg-root");
    const backgroundDirectory = path.join(diskImageRoot, ".background");
    await mkdir(backgroundDirectory, { recursive: true, mode: 0o755 });
    await command("ditto", [path.join(bundle.root, "MultiVibe Host.app"), path.join(diskImageRoot, "MultiVibe Host.app")]);
    await symlink("/Applications", path.join(diskImageRoot, "Applications"));
    await cp(
      path.join(repositoryRoot, "packaging", "macos", macOSDiskImageBackground),
      path.join(backgroundDirectory, macOSDiskImageBackground),
    );
    await command("hdiutil", [
      "create", "-quiet", "-volname", "MultiVibe Host", "-srcfolder", diskImageRoot,
      "-format", "UDZO", "-imagekey", "zlib-level=9", "-fs", "HFS+", destination,
    ]);
    if (options.signIdentity) {
      await command("codesign", ["--force", "--sign", options.signIdentity, "--timestamp", destination]);
    }
    if (options.notaryProfile) await notarizeMacDiskImage(destination, options.notaryProfile);
  } else if (selectedTarget.archive === "tar.gz") {
    await command("tar", [
      "--format=ustar",
      "-czf",
      destination,
      "-C",
      path.dirname(bundle.root),
      path.basename(bundle.root),
    ]);
  } else {
    if (process.platform === "win32") {
      await runWindowsPowerShell(
        [
          "$ErrorActionPreference = 'Stop'",
          "Add-Type -AssemblyName System.IO.Compression",
          "Add-Type -AssemblyName System.IO.Compression.FileSystem",
          "$source = [System.IO.Path]::GetFullPath($env:MULTIVIBE_PACKAGE_ARCHIVE_SOURCE)",
          "$parent = [System.IO.Path]::GetDirectoryName($source)",
          "$rootName = [System.IO.Path]::GetFileName($source)",
          "$archive = [System.IO.Compression.ZipFile]::Open($env:MULTIVIBE_PACKAGE_ARCHIVE_DESTINATION, [System.IO.Compression.ZipArchiveMode]::Create)",
          "try {",
          "  $directoryEntry = $archive.CreateEntry(($rootName + '/'), [System.IO.Compression.CompressionLevel]::Optimal)",
          "  $directoryEntry.ExternalAttributes = 0x10",
          "  foreach ($item in @(Get-ChildItem -LiteralPath $source -Force -Recurse | Sort-Object FullName)) {",
          "    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Windows release bundles may not contain reparse points.' }",
          "    $relative = $item.FullName.Substring($parent.Length + 1).Replace([System.IO.Path]::DirectorySeparatorChar, '/')",
          "    if ($item.PSIsContainer) {",
          "      $directoryEntry = $archive.CreateEntry(($relative + '/'), [System.IO.Compression.CompressionLevel]::Optimal)",
          "      $directoryEntry.ExternalAttributes = 0x10",
          "      continue",
          "    }",
          "    $entry = $archive.CreateEntry($relative, [System.IO.Compression.CompressionLevel]::Optimal)",
          "    $inputStream = [System.IO.File]::OpenRead($item.FullName)",
          "    try {",
          "      $outputStream = $entry.Open()",
          "      try { $inputStream.CopyTo($outputStream, 1048576) } finally { $outputStream.Dispose() }",
          "    } finally { $inputStream.Dispose() }",
          "  }",
          "} finally { $archive.Dispose() }",
        ].join('\n'),
        {
          MULTIVIBE_PACKAGE_ARCHIVE_SOURCE: bundle.root,
          MULTIVIBE_PACKAGE_ARCHIVE_DESTINATION: destination,
        },
      );
    } else {
      await command("zip", ["-q", "-r", destination, path.basename(bundle.root)], { cwd: path.dirname(bundle.root) });
    }
  }
  return destination;
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const selectedTarget = target();
  const dependencies = JSON.parse(await readFile(path.join(repositoryRoot, "packaging", "provider-host-dependencies.json"), "utf8"));
  if (dependencies.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/u.test(dependencies.node?.version ?? "")) {
    throw new Error("provider-host dependency manifest is invalid");
  }
  for (const key of ["darwin-arm64", "darwin-amd64", "linux-amd64", "linux-arm64", "windows-amd64"]) {
    validateDependency(`Node ${key}`, dependencies.node?.artifacts?.[key], key === "windows-amd64" ? "zip" : "tar-gzip");
  }
  const initialStatus = await command("git", ["status", "--porcelain"], { capture: true });
  if (initialStatus && !options.allowDirty) throw new Error("release packaging requires a clean worktree");
  const sourceCommit = await command("git", ["rev-parse", "HEAD"], { capture: true });
  const buildNumber = await command("git", ["rev-list", "--count", "HEAD"], { capture: true });
  // Run the web and API builds as separate packaging steps.
  await command("npm", ["run", "build:web"]);
  await command("npm", ["run", "build:api"]);
  await command("npm", ["run", "build:proxy-core-native"]);
  const finalStatus = await command("git", ["status", "--porcelain"], { capture: true });
  if (finalStatus && !options.allowDirty) throw new Error("the application build changed the release worktree");
  const work = await mkdtemp(path.join(tmpdir(), "multivibe-host-package-"));
  try {
    const bundle = await assemble(
      options, selectedTarget, work, dependencies, sourceCommit, buildNumber, Boolean(finalStatus),
    );
    const archive = await archiveBundle(bundle, options, selectedTarget);
    await command(process.execPath, [path.join(repositoryRoot, "scripts", "provider-host", "verify-provider-host.mjs"), archive]);
    console.log(JSON.stringify({ archive, sha256: await sha256(archive), sourceCommit, target: selectedTarget.key }));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (await invokedDirectly()) {
  main().catch((error) => {
    console.error(`provider-host package failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
