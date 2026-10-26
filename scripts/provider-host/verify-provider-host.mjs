#!/usr/bin/env node

import { createHash, createPublicKey } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createGunzip, createInflateRaw } from "node:zlib";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readlink, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { runMacStapler } from "./macos-stapler.mjs";

const maximumArchiveBytes = 6 * 1024 * 1024 * 1024;
const maximumExtractedBytes = 6 * 1024 * 1024 * 1024;
const maximumArchiveEntries = 100_000;
const maximumArchiveMetadataBytes = 8 * 1024 * 1024;
const maximumProviderDemandTrustBytes = 64 * 1024;
const maximumProviderDemandTrustKeys = 64;

function archiveMetadataCeilingError(metadataBytes, entryCount) {
  return new Error(
    `provider-host archive metadata exceeds the ceiling (${metadataBytes} bytes across ${entryCount} entries; limit ${maximumArchiveMetadataBytes} bytes)`,
  );
}
const maximumZipCentralDirectoryBytes = 128 * 1024 * 1024;
const maximumTarStreamBytes = maximumExtractedBytes + maximumArchiveEntries * 1024 + maximumArchiveMetadataBytes + 1024;
const maximumCommandOutputBytes = 64 * 1024 * 1024;
const expectedAppleTeamIdentifier = "5E2CNR9H47";
const approvedDownloadHosts = new Set(["nodejs.org", "github.com", "release-assets.githubusercontent.com"]);
const betterSQLiteSmokeTest = "const Database=require('better-sqlite3');const database=new Database(':memory:');try{const row=database.prepare('SELECT 1 AS value').get();if(row?.value!==1)throw new Error('better-sqlite3 smoke test failed')}finally{database.close()}";

function argumentsFrom(argv) {
  const options = { requireRuntime: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--require-runtime") options.requireRuntime = true;
    else if (argument === "--directory") {
      if (options.directory || options.archive || !argv[index + 1]) throw new Error("--directory requires one path");
      options.directory = path.resolve(argv[index + 1]);
      index += 1;
    } else if (!argument.startsWith("-") && !options.archive && !options.directory) {
      options.archive = path.resolve(argument);
    } else {
      throw new Error("usage: verify-provider-host.mjs [--require-runtime] <archive> | --directory <path>");
    }
  }
  if (Boolean(options.archive) === Boolean(options.directory)) {
    throw new Error("exactly one provider-host archive or directory is required");
  }
  return options;
}

async function command(program, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const captureStderr = options.capture && options.captureStderr === true;
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      // Keep stdout reserved for this verifier's single JSON result. macOS
      // validation tools such as `stapler` print progress on their stdout.
      stdio: options.capture ? ["ignore", "pipe", captureStderr ? "pipe" : "inherit"] : ["inherit", process.stderr, "inherit"],
      shell: false,
    });
    let output = "";
    let outputExceeded = false;
    const capture = (stream) => stream?.setEncoding("utf8").on("data", (chunk) => {
        output += chunk;
        if (Buffer.byteLength(output) > (options.captureLimit ?? maximumCommandOutputBytes)) {
          outputExceeded = true;
          child.kill("SIGKILL");
        }
      });
    if (options.capture) capture(child.stdout);
    if (captureStderr) capture(child.stderr);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (outputExceeded) reject(new Error(`${program} produced excessive output`));
      else if (code === 0) resolve(output.trim());
      else reject(Object.assign(new Error(`${program} failed with ${signal ?? `exit ${code}`}`), { code, signal }));
    });
  });
}

export { command as runVerificationCommand };

function encodedPowerShellCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function windowsPowerShellPath() {
  const systemRoot = process.env.SystemRoot?.trim();
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error("Windows PowerShell is unavailable");
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

async function extractZipArchive(archive, destination) {
  if (process.platform !== "win32") {
    await command("unzip", ["-q", archive, "-d", destination]);
    return;
  }
  const environment = {
    ...process.env,
    MULTIVIBE_VERIFY_ZIP_SOURCE: archive,
    MULTIVIBE_VERIFY_ZIP_DESTINATION: destination,
  };
  await command(windowsPowerShellPath(), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand",
    encodedPowerShellCommand(
      "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:MULTIVIBE_VERIFY_ZIP_SOURCE -DestinationPath $env:MULTIVIBE_VERIFY_ZIP_DESTINATION -Force",
    ),
  ], { env: environment });
}

async function sha256(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function safeRelative(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !value.startsWith("/") && !value.includes("\\") && !/[\0-\x1f\x7f]/u.test(value) &&
    path.posix.normalize(value) === value &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function safeArchiveEntry(value) {
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  return safeRelative(normalized) && normalized.length <= 1024;
}

async function allFiles(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`provider-host archive contains a symlink: ${child}`);
    if (entry.isDirectory()) files.push(...await allFiles(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`provider-host archive contains an unsupported entry: ${child}`);
  }
  return files;
}

async function readExactly(handle, position, length, fileSize) {
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0 ||
    position + length > fileSize) {
    throw new Error("provider-host archive structure is invalid");
  }
  const value = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(value, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error("provider-host archive is truncated");
    offset += bytesRead;
  }
  return value;
}

function asciiArchiveName(value) {
  if (value.length < 1 || [...value].some((byte) => byte < 0x20 || byte > 0x7e)) {
    throw new Error("provider-host archive contains a non-ASCII path");
  }
  return value.toString("ascii");
}

function validateZipExtra(value) {
  let offset = 0;
  while (offset < value.length) {
    if (offset + 4 > value.length) throw new Error("provider-host zip metadata is invalid");
    const identifier = value.readUInt16LE(offset);
    const length = value.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + length > value.length) throw new Error("provider-host zip metadata is invalid");
    // Timestamp and numeric uid/gid fields are the only extractor-visible extras
    // emitted by the release tools. Zip64, Unicode path overrides and encryption
    // extras are deliberately unsupported so the inspected name is the extracted name.
    if (![0x5455, 0x5855, 0x7875].includes(identifier)) {
      throw new Error("provider-host zip contains unsupported metadata");
    }
    offset += length;
  }
}

function zipEntryKind(versionMadeBy, externalAttributes, name) {
  const trailingSlash = name.endsWith("/");
  const creator = versionMadeBy >>> 8;
  if (creator === 3 || creator === 19) {
    const type = (externalAttributes >>> 16) & 0o170000;
    if (type !== 0 && type !== 0o100000 && type !== 0o040000) {
      throw new Error("provider-host archive contains a link or special entry");
    }
    if ((type === 0o040000) !== trailingSlash || (type === 0o100000 && trailingSlash)) {
      throw new Error("provider-host zip entry type is inconsistent");
    }
  } else {
    const dosDirectory = (externalAttributes & 0x10) !== 0;
    if (dosDirectory !== trailingSlash) throw new Error("provider-host zip entry type is inconsistent");
  }
  return trailingSlash ? "directory" : "file";
}

async function validateZipDeflatePayload(archive, entry) {
  if (entry.compressedSize < 1) throw new Error("provider-host zip deflate payload is invalid");
  const source = createReadStream(archive, {
    start: entry.dataOffset,
    end: entry.dataOffset + entry.compressedSize - 1,
  });
  const inflater = createInflateRaw();
  source.once("error", (error) => inflater.destroy(error));
  source.pipe(inflater);
  let actual = 0;
  try {
    for await (const chunk of inflater) {
      actual += chunk.length;
      if (actual > entry.uncompressedSize || actual > maximumExtractedBytes) {
        throw new Error("provider-host archive exceeds the extracted-size ceiling");
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("extracted-size ceiling")) throw error;
    throw new Error("provider-host zip payload is invalid");
  } finally {
    source.destroy();
    inflater.destroy();
  }
  if (actual !== entry.uncompressedSize) throw new Error("provider-host zip declared size is inconsistent");
}

async function inspectZipArchive(archive, archiveInfo) {
  const handle = await open(archive, "r");
  try {
    if (archiveInfo.size < 22) throw new Error("provider-host zip is truncated");
    const tailLength = Math.min(archiveInfo.size, 22 + 0xffff);
    const tailPosition = archiveInfo.size - tailLength;
    const tail = await readExactly(handle, tailPosition, tailLength, archiveInfo.size);
    let endOffset = -1;
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === 0x06054b50 &&
        offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) {
        endOffset = tailPosition + offset;
        break;
      }
    }
    if (endOffset < 0) throw new Error("provider-host zip end record is invalid");
    const end = tail.subarray(endOffset - tailPosition);
    const disk = end.readUInt16LE(4);
    const centralDisk = end.readUInt16LE(6);
    const diskEntries = end.readUInt16LE(8);
    const entryCount = end.readUInt16LE(10);
    const centralSize = end.readUInt32LE(12);
    const centralOffset = end.readUInt32LE(16);
    const commentLength = end.readUInt16LE(20);
    if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount || entryCount === 0 ||
      entryCount === 0xffff || entryCount > maximumArchiveEntries || centralSize === 0xffffffff ||
      centralOffset === 0xffffffff || centralSize > maximumZipCentralDirectoryBytes || commentLength !== 0 ||
      centralOffset + centralSize !== endOffset) {
      throw new Error("provider-host zip layout is unsupported or exceeds a ceiling");
    }
    const central = await readExactly(handle, centralOffset, centralSize, archiveInfo.size);
    const entries = [];
    const names = new Set();
    const foldedNames = new Set();
    let centralCursor = 0;
    let metadataBytes = 0;
    let extractedBytes = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (centralCursor + 46 > central.length || central.readUInt32LE(centralCursor) !== 0x02014b50) {
        throw new Error("provider-host zip central directory is invalid");
      }
      const versionMadeBy = central.readUInt16LE(centralCursor + 4);
      const versionNeeded = central.readUInt16LE(centralCursor + 6);
      const flags = central.readUInt16LE(centralCursor + 8);
      const method = central.readUInt16LE(centralCursor + 10);
      const crc32 = central.readUInt32LE(centralCursor + 16);
      const compressedSize = central.readUInt32LE(centralCursor + 20);
      const uncompressedSize = central.readUInt32LE(centralCursor + 24);
      const nameLength = central.readUInt16LE(centralCursor + 28);
      const extraLength = central.readUInt16LE(centralCursor + 30);
      const entryCommentLength = central.readUInt16LE(centralCursor + 32);
      const diskStart = central.readUInt16LE(centralCursor + 34);
      const externalAttributes = central.readUInt32LE(centralCursor + 38);
      const localOffset = central.readUInt32LE(centralCursor + 42);
      const recordLength = 46 + nameLength + extraLength + entryCommentLength;
      if (centralCursor + recordLength > central.length || versionNeeded > 20 || diskStart !== 0 ||
        compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff ||
        ![0, 8].includes(method) || (flags & ~0x080e) !== 0 || (method === 0 && (flags & 0x0006) !== 0)) {
        throw new Error("provider-host zip entry uses unsupported features");
      }
      const nameBytes = central.subarray(centralCursor + 46, centralCursor + 46 + nameLength);
      const extra = central.subarray(centralCursor + 46 + nameLength, centralCursor + 46 + nameLength + extraLength);
      const name = asciiArchiveName(nameBytes);
      const canonicalName = name.endsWith("/") ? name.slice(0, -1) : name;
      const foldedName = canonicalName.toLowerCase();
      metadataBytes += nameLength + extraLength + entryCommentLength;
      if (metadataBytes > maximumArchiveMetadataBytes) throw archiveMetadataCeilingError(metadataBytes, entryCount);
      validateZipExtra(extra);
      if (!safeArchiveEntry(name)) throw new Error("provider-host archive contains an unsafe path");
      if (names.has(canonicalName) || foldedNames.has(foldedName)) {
        throw new Error("provider-host archive contains duplicate paths");
      }
      names.add(canonicalName);
      foldedNames.add(foldedName);
      const kind = zipEntryKind(versionMadeBy, externalAttributes, name);
      if (kind === "directory" && (compressedSize !== 0 || uncompressedSize !== 0)) {
        throw new Error("provider-host zip directory has data");
      }
      if (method === 0 && compressedSize !== uncompressedSize) {
        throw new Error("provider-host zip stored size is inconsistent");
      }
      extractedBytes += uncompressedSize;
      if (extractedBytes > maximumExtractedBytes) throw new Error("provider-host archive exceeds the extracted-size ceiling");
      entries.push({
        name, canonicalName, kind, flags, method, crc32, compressedSize, uncompressedSize, localOffset,
        dataOffset: 0, rangeEnd: 0,
      });
      centralCursor += recordLength;
    }
    if (centralCursor !== central.length) throw new Error("provider-host zip central directory has trailing data");

    for (const entry of entries) {
      const local = await readExactly(handle, entry.localOffset, 30, archiveInfo.size);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== entry.flags ||
        local.readUInt16LE(8) !== entry.method) {
        throw new Error("provider-host zip local header is inconsistent");
      }
      const localCrc = local.readUInt32LE(14);
      const localCompressedSize = local.readUInt32LE(18);
      const localUncompressedSize = local.readUInt32LE(22);
      const localNameLength = local.readUInt16LE(26);
      const localExtraLength = local.readUInt16LE(28);
      const localMetadata = await readExactly(handle, entry.localOffset + 30,
        localNameLength + localExtraLength, archiveInfo.size);
      const localName = localMetadata.subarray(0, localNameLength);
      const localExtra = localMetadata.subarray(localNameLength);
      metadataBytes += localNameLength + localExtraLength;
      if (metadataBytes > maximumArchiveMetadataBytes) throw archiveMetadataCeilingError(metadataBytes, entryCount);
      validateZipExtra(localExtra);
      if (!localName.equals(Buffer.from(entry.name, "ascii"))) {
        throw new Error("provider-host zip local path differs from its central path");
      }
      const usesDescriptor = (entry.flags & 0x0008) !== 0;
      if ((!usesDescriptor && (localCrc !== entry.crc32 || localCompressedSize !== entry.compressedSize ||
        localUncompressedSize !== entry.uncompressedSize)) || (usesDescriptor &&
        ![0, entry.crc32].includes(localCrc)) || (usesDescriptor &&
        ![0, entry.compressedSize].includes(localCompressedSize)) || (usesDescriptor &&
        ![0, entry.uncompressedSize].includes(localUncompressedSize))) {
        throw new Error("provider-host zip local sizes are inconsistent");
      }
      entry.dataOffset = entry.localOffset + 30 + localNameLength + localExtraLength;
      let rangeEnd = entry.dataOffset + entry.compressedSize;
      if (rangeEnd > centralOffset) throw new Error("provider-host zip payload range is invalid");
      if (usesDescriptor) {
        const available = centralOffset - rangeEnd;
        if (available < 12) throw new Error("provider-host zip data descriptor is truncated");
        const descriptor = await readExactly(handle, rangeEnd, Math.min(16, available), archiveInfo.size);
        const signed = descriptor.readUInt32LE(0) === 0x08074b50;
        const cursor = signed ? 4 : 0;
        if (descriptor.length < cursor + 12 || descriptor.readUInt32LE(cursor) !== entry.crc32 ||
          descriptor.readUInt32LE(cursor + 4) !== entry.compressedSize ||
          descriptor.readUInt32LE(cursor + 8) !== entry.uncompressedSize) {
          throw new Error("provider-host zip data descriptor is inconsistent");
        }
        rangeEnd += cursor + 12;
      }
      entry.rangeEnd = rangeEnd;
    }
    const localOrder = [...entries].sort((left, right) => left.localOffset - right.localOffset);
    let previousEnd = 0;
    for (const entry of localOrder) {
      if (entry.localOffset < previousEnd || entry.rangeEnd > centralOffset) {
        throw new Error("provider-host zip entries overlap");
      }
      previousEnd = entry.rangeEnd;
    }
    for (const entry of entries) {
      if (entry.kind === "file" && entry.method === 8) await validateZipDeflatePayload(archive, entry);
    }
    const roots = new Set(entries.map((entry) => entry.canonicalName.split("/", 1)[0]));
    if (roots.size !== 1) throw new Error("provider-host archive root is invalid");
    return { root: [...roots][0], fileModes: null };
  } finally {
    await handle.close();
  }
}

function parseTarNumber(value, label) {
  if (value.length < 1) throw new Error(`provider-host tar ${label} is invalid`);
  if ((value[0] & 0x80) !== 0) {
    const bits = BigInt(value.length * 8 - 1);
    let parsed = BigInt(value[0] & 0x7f);
    for (const byte of value.subarray(1)) parsed = (parsed << 8n) | BigInt(byte);
    if ((value[0] & 0x40) !== 0) parsed -= 1n << bits;
    if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`provider-host tar ${label} is out of range`);
    }
    return Number(parsed);
  }
  let start = 0;
  while (start < value.length && (value[start] === 0 || value[start] === 0x20)) start += 1;
  let end = start;
  while (end < value.length && value[end] >= 0x30 && value[end] <= 0x37) end += 1;
  for (const byte of value.subarray(end)) {
    if (byte !== 0 && byte !== 0x20) throw new Error(`provider-host tar ${label} is invalid`);
  }
  if (start === end) return 0;
  const parsed = Number.parseInt(value.subarray(start, end).toString("ascii"), 8);
  if (!Number.isSafeInteger(parsed)) throw new Error(`provider-host tar ${label} is out of range`);
  return parsed;
}

function parseTarString(value) {
  const terminator = value.indexOf(0);
  const end = terminator < 0 ? value.length : terminator;
  for (const byte of value.subarray(end)) {
    if (byte !== 0 && byte !== 0x20) throw new Error("provider-host tar string field is invalid");
  }
  const content = value.subarray(0, end);
  if ([...content].some((byte) => byte < 0x20 || byte > 0x7e)) {
    throw new Error("provider-host tar contains a non-ASCII path");
  }
  return content.toString("ascii");
}

function validateTarChecksum(header) {
  const expected = parseTarNumber(header.subarray(148, 156), "checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) throw new Error("provider-host tar checksum is invalid");
}

function parsePaxRecords(payload) {
  const records = new Map();
  let offset = 0;
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset);
    if (space < 0 || space === offset) throw new Error("provider-host tar PAX metadata is invalid");
    const lengthText = payload.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]{0,6}$/u.test(lengthText)) throw new Error("provider-host tar PAX metadata is invalid");
    const length = Number.parseInt(lengthText, 10);
    if (length < space - offset + 4 || offset + length > payload.length || payload[offset + length - 1] !== 0x0a) {
      throw new Error("provider-host tar PAX metadata is invalid");
    }
    const record = payload.subarray(space + 1, offset + length - 1);
    const equals = record.indexOf(0x3d);
    if (equals < 1) throw new Error("provider-host tar PAX metadata is invalid");
    const key = record.subarray(0, equals).toString("ascii");
    const value = record.subarray(equals + 1).toString("utf8");
    if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(key) || records.has(key) || value.includes("\u0000") ||
      key.startsWith("GNU.sparse") || key === "SCHILY.realsize" || key === "linkpath" ||
      !["path", "size", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname", "charset", "comment"].includes(key)) {
      throw new Error("provider-host tar PAX metadata is unsupported");
    }
    records.set(key, value);
    offset += length;
  }
  return records;
}

class BoundedTarReader {
  constructor(stream) {
    this.stream = stream;
    this.iterator = stream[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
    this.offset = 0;
    this.ended = false;
    this.produced = 0;
  }

  async pull() {
    if (this.ended) return false;
    const next = await this.iterator.next();
    if (next.done) {
      this.ended = true;
      return false;
    }
    this.buffer = next.value;
    this.offset = 0;
    this.produced += next.value.length;
    if (this.produced > maximumTarStreamBytes) {
      throw new Error("provider-host tar stream exceeds the verification ceiling");
    }
    return true;
  }

  async read(length, allowEnd = false) {
    const output = Buffer.alloc(length);
    let written = 0;
    while (written < length) {
      if (this.offset >= this.buffer.length && !await this.pull()) {
        if (allowEnd && written === 0) return null;
        throw new Error("provider-host tar stream is truncated");
      }
      const available = Math.min(length - written, this.buffer.length - this.offset);
      this.buffer.copy(output, written, this.offset, this.offset + available);
      this.offset += available;
      written += available;
    }
    return output;
  }

  async skip(length) {
    let remaining = length;
    while (remaining > 0) {
      if (this.offset >= this.buffer.length && !await this.pull()) {
        throw new Error("provider-host tar stream is truncated");
      }
      const available = Math.min(remaining, this.buffer.length - this.offset);
      this.offset += available;
      remaining -= available;
    }
  }
}

async function inspectTarArchive(archive) {
  const source = createReadStream(archive);
  const gunzip = createGunzip();
  source.once("error", (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  const reader = new BoundedTarReader(gunzip);
  const names = new Set();
  const foldedNames = new Set();
  const archiveNames = [];
  const archiveFileModes = new Map();
  let metadataBytes = 0;
  let extractedBytes = 0;
  let entryCount = 0;
  let pendingPax = null;
  let pendingLongName = null;
  let sawEnd = false;
  try {
    while (true) {
      const header = await reader.read(512, true);
      if (header === null) break;
      if (header.every((byte) => byte === 0)) {
        const second = await reader.read(512);
        if (!second.every((byte) => byte === 0)) throw new Error("provider-host tar end marker is invalid");
        sawEnd = true;
        while (true) {
          const padding = await reader.read(512, true);
          if (padding === null) break;
          if (!padding.every((byte) => byte === 0)) throw new Error("provider-host tar has trailing data");
        }
        break;
      }
      validateTarChecksum(header);
      entryCount += 1;
      if (entryCount > maximumArchiveEntries) throw new Error("provider-host archive contains too many entries");
      const headerName = parseTarString(header.subarray(0, 100));
      const prefix = parseTarString(header.subarray(345, 500));
      const linkName = parseTarString(header.subarray(157, 257));
      const typeByte = header[156];
      const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
      const headerSize = parseTarNumber(header.subarray(124, 136), "size");
      const headerMode = parseTarNumber(header.subarray(100, 108), "mode");
      if (headerMode > 0o777) throw new Error("provider-host tar entry mode is invalid");
      metadataBytes += Buffer.byteLength(headerName) + Buffer.byteLength(prefix) + Buffer.byteLength(linkName);
      if (metadataBytes > maximumArchiveMetadataBytes) throw archiveMetadataCeilingError(metadataBytes, entryCount);

      if (type === "x" || type === "L") {
        if (headerSize > maximumArchiveMetadataBytes - metadataBytes) {
          throw archiveMetadataCeilingError(metadataBytes + headerSize, entryCount);
        }
        const payload = await reader.read(headerSize);
        await reader.skip((512 - (headerSize % 512)) % 512);
        metadataBytes += headerSize;
        if (type === "x") {
          if (pendingPax !== null) throw new Error("provider-host tar has ambiguous PAX metadata");
          pendingPax = parsePaxRecords(payload);
        } else {
          if (pendingLongName !== null) throw new Error("provider-host tar has ambiguous GNU metadata");
          let end = payload.length;
          while (end > 0 && payload[end - 1] === 0) end -= 1;
          pendingLongName = asciiArchiveName(payload.subarray(0, end));
        }
        continue;
      }
      if (type === "g") throw new Error("provider-host tar global PAX metadata is unsupported");
      if (["1", "2", "3", "4", "6", "K", "S"].includes(type)) {
        throw new Error("provider-host archive contains a link or special entry");
      }
      if (!["0", "5"].includes(type)) throw new Error("provider-host tar entry type is unsupported");
      if (pendingPax !== null && pendingLongName !== null) {
        throw new Error("provider-host tar path metadata is ambiguous");
      }
      if (linkName !== "") throw new Error("provider-host tar regular entry has link metadata");
      const paxPath = pendingPax?.get("path");
      const joinedHeaderName = prefix ? `${prefix}/${headerName}` : headerName;
      const name = paxPath ?? pendingLongName ?? joinedHeaderName;
      let size = headerSize;
      if (pendingPax?.has("size")) {
        const value = pendingPax.get("size");
        if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(value)) throw new Error("provider-host tar PAX size is invalid");
        const parsed = BigInt(value);
        if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("provider-host tar PAX size is out of range");
        size = Number(parsed);
      }
      pendingPax = null;
      pendingLongName = null;
      if (typeof name !== "string" || !safeArchiveEntry(name)) {
        throw new Error("provider-host archive contains an unsafe path");
      }
      if (![...Buffer.from(name, "utf8")].every((byte) => byte >= 0x20 && byte <= 0x7e)) {
        throw new Error("provider-host tar contains a non-ASCII path");
      }
      const canonicalName = name.endsWith("/") ? name.slice(0, -1) : name;
      const foldedName = canonicalName.toLowerCase();
      if (names.has(canonicalName) || foldedNames.has(foldedName)) {
        throw new Error("provider-host archive contains duplicate paths");
      }
      names.add(canonicalName);
      foldedNames.add(foldedName);
      const directory = type === "5";
      if (directory !== name.endsWith("/") || (directory && size !== 0)) {
        throw new Error("provider-host tar entry type is inconsistent");
      }
      if (!directory) {
        extractedBytes += size;
        if (extractedBytes > maximumExtractedBytes) {
          throw new Error("provider-host archive exceeds the extracted-size ceiling");
        }
      }
      archiveNames.push(canonicalName);
      if (!directory) archiveFileModes.set(canonicalName, headerMode);
      await reader.skip(size);
      await reader.skip((512 - (size % 512)) % 512);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("provider-host")) throw error;
    throw new Error("provider-host tar stream is invalid");
  } finally {
    source.destroy();
    gunzip.destroy();
  }
  if (!sawEnd || pendingPax !== null || pendingLongName !== null || archiveNames.length < 1) {
    throw new Error("provider-host tar termination is invalid");
  }
  const roots = new Set(archiveNames.map((name) => name.split("/", 1)[0]));
  if (roots.size !== 1) throw new Error("provider-host archive root is invalid");
  const root = [...roots][0];
  const fileModes = new Map();
  for (const [name, mode] of archiveFileModes) {
    if (!name.startsWith(`${root}/`)) throw new Error("provider-host archive root is invalid");
    fileModes.set(name.slice(root.length + 1), mode);
  }
  return { root, fileModes };
}

async function inspectArchive(archive) {
  const archiveInfo = await stat(archive);
  if (!archiveInfo.isFile() || archiveInfo.size < 1 || archiveInfo.size > maximumArchiveBytes) {
    throw new Error("provider-host archive is invalid or exceeds the verification ceiling");
  }
  if (archive.endsWith(".zip")) return await inspectZipArchive(archive, archiveInfo);
  if (archive.endsWith(".tar.gz")) return await inspectTarArchive(archive);
  throw new Error("provider-host archive format is unsupported");
}

function validateDependency(name, dependency, expectedArchives) {
  if (!exactKeys(dependency, ["version", "artifacts"]) || !/^\d+\.\d+\.\d+$/u.test(dependency.version) ||
    !(exactKeys(dependency.artifacts, ["darwin-amd64", "darwin-arm64", "linux-amd64", "windows-amd64"]) ||
      exactKeys(dependency.artifacts, ["darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64", "windows-amd64"]))) {
    throw new Error(`${name} dependency metadata is invalid`);
  }
  for (const [target, artifact] of Object.entries(dependency.artifacts)) {
    if (!exactKeys(artifact, ["url", "sha256", "archive"]) ||
      typeof artifact.url !== "string" || !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
      artifact.archive !== expectedArchives[target]) {
      throw new Error(`${name} dependency artifact metadata is invalid`);
    }
    const url = new URL(artifact.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || !approvedDownloadHosts.has(url.hostname)) {
      throw new Error(`${name} dependency URL is invalid`);
    }
  }
}

function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function readBinaryHeader(file, bytes = 4096) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export function isELFArchitecture(header, architecture) {
  return header.length >= 20 && header[0] === 0x7f && header.subarray(1, 4).toString("ascii") === "ELF" &&
    header[4] === 2 && header[5] === 1 && header.readUInt16LE(18) === (architecture === "arm64" ? 0xb7 : architecture === "amd64" ? 0x3e : -1);
}

function isPEAmd64(header) {
  if (header.length < 64 || header.subarray(0, 2).toString("ascii") !== "MZ") return false;
  const peOffset = header.readUInt32LE(0x3c);
  return peOffset >= 64 && peOffset + 26 <= header.length &&
    header.subarray(peOffset, peOffset + 4).toString("ascii") === "PE\0\0" &&
    header.readUInt16LE(peOffset + 4) === 0x8664 && header.readUInt16LE(peOffset + 24) === 0x20b;
}

function isMachOArchitecture(header, cpuType) {
  if (header.length < 8) return false;
  if (header.readUInt32LE(0) === 0xfeedfacf) return header.readUInt32LE(4) === cpuType;
  if (header.readUInt32BE(0) === 0xfeedfacf) return header.readUInt32BE(4) === cpuType;
  const magic = header.readUInt32BE(0);
  const fat64 = magic === 0xcafebabf;
  if (magic !== 0xcafebabe && !fat64) return false;
  const count = header.readUInt32BE(4);
  const entryBytes = fat64 ? 32 : 20;
  if (count < 1 || count > 32 || header.length < 8 + count * entryBytes) return false;
  for (let index = 0; index < count; index += 1) {
    if (header.readUInt32BE(8 + index * entryBytes) === cpuType) return true;
  }
  return false;
}

function isMachO(header) {
  if (header.length < 4) return false;
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xcafebabf,
    0xbebafeca, 0xbfbafeca].includes(header.readUInt32BE(0));
}

async function validateNativeFiles(root, manifest) {
  const mac = manifest.platform === "darwin";
  const windows = manifest.platform === "windows";
  const prefix = mac ? "MultiVibe Host.app/Contents/" : "";
  const explicit = mac ? [
    `${prefix}Frameworks/node`, `${prefix}Helpers/multivibe-host-updater`,
    `${prefix}Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework`,
    `${prefix}Frameworks/MultiVibe Chromium Helper.app/Contents/MacOS/MultiVibe Chromium Helper`,
    `${prefix}Helpers/multivibe-v1-edge`,
    `${prefix}MacOS/multivibe-host`,
    `${prefix}MacOS/MultiVibe Host`,
  ] : windows ? [
    "bin/node.exe",
    "bin/multivibe-host-updater.exe", "bin/multivibe-host.exe", "bin/multivibe-host-menu.exe",
  ] : ["bin/node", "bin/multivibe-host-updater", "bin/multivibe-host", "bin/multivibe-host-menu"];
  const native = manifest.files.filter((entry) => explicit.includes(entry.path) ||
    (mac ? /\.(?:dylib|node|so)$/u.test(entry.path) : windows ? /\.(?:dll|exe|node)$/iu.test(entry.path) : /(?:\.node$|\.so(?:\.|$))/u.test(entry.path)));
  for (const entry of native) {
    const header = await readBinaryHeader(path.join(root, entry.path), windows ? 64 * 1024 : 4096);
    const macCPUType = manifest.architecture === "arm64" ? 0x0100000c : manifest.architecture === "amd64" ? 0x01000007 : null;
    const valid = mac ? (macCPUType !== null && isMachO(header) &&
      isMachOArchitecture(header, macCPUType)) :
      windows ? isPEAmd64(header) : isELFArchitecture(header, manifest.architecture);
    if (!valid) {
      throw new Error(`provider-host native file has the wrong architecture: ${entry.path}`);
    }
  }
}

async function validateTree(root, options, archiveInspection) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("provider-host directory is invalid");
  const manifestPath = path.join(root, "manifest.json");
  const manifestRaw = await readFile(manifestPath, "utf8");
  if (Buffer.byteLength(manifestRaw) > 4 * 1024 * 1024) throw new Error("provider-host manifest is too large");
  const manifest = JSON.parse(manifestRaw);
  const manifestKeys = ["schemaVersion", "product", "version", "sourceCommit", "platform", "architecture",
    "sourceTreeDirty", "releaseReady", "macOSSignature", "node", "files"];
  const targetIsValid = (manifest.platform === "darwin" && ["arm64", "amd64"].includes(manifest.architecture)) ||
    ((manifest.platform === "linux" && ["amd64", "arm64"].includes(manifest.architecture)) || (manifest.platform === "windows" && manifest.architecture === "amd64"));
  if (!exactKeys(manifest, manifestKeys) || manifest.schemaVersion !== 1 || manifest.product !== "multivibe-host" ||
    typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version) ||
    typeof manifest.sourceCommit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(manifest.sourceCommit) ||
    !targetIsValid || typeof manifest.sourceTreeDirty !== "boolean" || typeof manifest.releaseReady !== "boolean" ||
    !Array.isArray(manifest.files) || manifest.files.length < 12 || manifest.files.length > 100_000) {
    throw new Error("provider-host manifest schema is invalid");
  }
  const expectedMacSignature = manifest.platform === "darwin";
  if ((expectedMacSignature && !["unsigned-development", "developer-id", "developer-id-notarized"].includes(manifest.macOSSignature)) ||
    (!expectedMacSignature && manifest.macOSSignature !== null) || manifest.releaseReady !== (!manifest.sourceTreeDirty &&
      (manifest.platform !== "darwin" || manifest.macOSSignature === "developer-id-notarized"))) {
    throw new Error("provider-host release-readiness metadata is inconsistent");
  }
  validateDependency("Node", manifest.node, {
    "darwin-amd64": "tar-gzip", "darwin-arm64": "tar-gzip", "linux-amd64": "tar-gzip", "linux-arm64": "tar-gzip", "windows-amd64": "zip",
  });

  if (archiveInspection) {
    const expectedRoot = `multivibe-host_${manifest.version}_${manifest.platform}_${manifest.architecture}`;
    if (archiveInspection.root !== expectedRoot || path.basename(root) !== expectedRoot) {
      throw new Error("provider-host archive name is inconsistent");
    }
  }

  const seen = new Set();
  let previous = "";
  for (const entry of manifest.files) {
    if (!exactKeys(entry, ["path", "size", "mode", "sha256"]) || !safeRelative(entry.path) || seen.has(entry.path) ||
      (previous && previous.localeCompare(entry.path) >= 0) || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
      entry.size > maximumArchiveBytes || !Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 ||
      typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
      throw new Error("provider-host manifest entry is invalid");
    }
    previous = entry.path;
    seen.add(entry.path);
    const file = path.join(root, entry.path);
    const info = await lstat(file);
    const modeMatches = manifest.platform === "windows" || (archiveInspection?.fileModes instanceof Map
      ? archiveInspection.fileModes.get(entry.path) === entry.mode
      : (info.mode & 0o777) === entry.mode);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.size ||
      !modeMatches ||
      await sha256(file) !== entry.sha256) {
      throw new Error(`provider-host file verification failed: ${entry.path}`);
    }
  }

  const actualFiles = (await allFiles(root)).sort((left, right) => left.localeCompare(right));
  const expectedFiles = [...seen, "manifest.json"].sort((left, right) => left.localeCompare(right));
  if (actualFiles.length !== expectedFiles.length || actualFiles.some((file, index) => file !== expectedFiles[index])) {
    throw new Error("provider-host archive contains files outside the signed manifest");
  }

  const macPrefix = "MultiVibe Host.app/Contents";
  const required = ["LICENSE", "NOTICE", "README.md", "THIRD_PARTY/node-LICENSE",
    "THIRD_PARTY/provider-host-dependencies.json"];
  if (manifest.platform === "darwin") required.push(
    "install.sh", "uninstall.sh", `${macPrefix}/Frameworks/node`,
    `${macPrefix}/MacOS/multivibe-host`, `${macPrefix}/MacOS/MultiVibe Host`,
    `${macPrefix}/Helpers/multivibe-host-updater`, `${macPrefix}/Helpers/multivibe-v1-edge`,
    `${macPrefix}/Resources/MultiVibeMenuBarTemplate.png`, `${macPrefix}/Resources/MultiVibe.icns`,
    `${macPrefix}/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework`,
    `${macPrefix}/Frameworks/MultiVibe Chromium Helper.app/Contents/MacOS/MultiVibe Chromium Helper`,
    `${macPrefix}/Resources/ChromiumEmbeddedFramework-LICENSE.txt`,
    `${macPrefix}/Resources/app/dist/server.js`, `${macPrefix}/Resources/app/dist/instrument.js`,
    `${macPrefix}/Resources/app/modules/security/multivibe.module.json`,
    `${macPrefix}/Resources/app/modules/security/dist/index.js`,
    `${macPrefix}/Resources/verify-provider-host.mjs`, `${macPrefix}/Info.plist`,
  );
  else {
    const suffix = manifest.platform === "windows" ? ".exe" : "";
    required.push(
      `install.${suffix ? "ps1" : "sh"}`, `uninstall.${suffix ? "ps1" : "sh"}`,
      `bin/node${suffix}`, `bin/multivibe-host${suffix}`, `bin/multivibe-host-updater${suffix}`,
      `bin/multivibe-host-menu${suffix}`, "app/dist/server.js", "app/dist/instrument.js",
      "app/modules/security/multivibe.module.json", "app/modules/security/dist/index.js", "verify-provider-host.mjs",
      `resources/provider/multivibe-host.${suffix ? "ico" : "png"}`,
    );
  }
  for (const file of required) {
    if (!seen.has(file)) throw new Error(`provider-host required file is missing: ${file}`);
  }
  if (manifest.platform === "darwin") {
    const icon = await readBinaryHeader(path.join(root, macPrefix, "Resources", "MultiVibe.icns"), 8);
    if (icon.length < 8 || icon.subarray(0, 4).toString("ascii") !== "icns" || icon.readUInt32BE(4) < 1024) {
      throw new Error("provider-host macOS application icon is invalid");
    }
  }
  if (manifest.platform === "darwin" && manifest.macOSSignature !== "unsigned-development" &&
    !seen.has(`${macPrefix}/_CodeSignature/CodeResources`)) {
    throw new Error("provider-host signed application metadata is missing");
  }

  const dependencyFile = JSON.parse(await readFile(path.join(root, "THIRD_PARTY", "provider-host-dependencies.json"), "utf8"));
  if (dependencyFile.schemaVersion !== 1 || canonicalJSON(dependencyFile.node) !== canonicalJSON(manifest.node)) {
    throw new Error("provider-host dependency metadata does not match the manifest");
  }
  await validateNativeFiles(root, manifest);

  const application = manifest.platform === "darwin" ? path.join(root, "MultiVibe Host.app") : null;
  if (application && manifest.macOSSignature !== "unsigned-development" && process.platform === "darwin") {
    await command("codesign", ["--verify", "--deep", "--strict", "--verbose=2", application]);
    const signatureDetails = await command("codesign", ["-d", "--verbose=4", application], {
      capture: true,
      captureStderr: true,
      captureLimit: 64 * 1024,
    });
    const teamIdentifiers = signatureDetails.split("\n").map((line) => /^TeamIdentifier=(\S+)$/u.exec(line.trim()))
      .filter(Boolean).map((match) => match[1]);
    if (teamIdentifiers.length !== 1 || teamIdentifiers[0] !== expectedAppleTeamIdentifier) {
      throw new Error("provider-host macOS TeamIdentifier is invalid");
    }
    if (manifest.macOSSignature === "developer-id-notarized") {
      await runMacStapler("validate", application, command);
      await command("spctl", ["--assess", "--type", "execute", "--verbose=2", application]);
    }
  }

  const executableSuffix = manifest.platform === "windows" ? ".exe" : "";
  const host = manifest.platform === "darwin" ? path.join(application, "Contents", "MacOS", "multivibe-host") : path.join(root, "bin", `multivibe-host${executableSuffix}`);
  const updater = manifest.platform === "darwin" ? path.join(application, "Contents", "Helpers", "multivibe-host-updater") : path.join(root, "bin", `multivibe-host-updater${executableSuffix}`);
  const menu = manifest.platform === "darwin" ? null : path.join(root, "bin", `multivibe-host-menu${executableSuffix}`);
  const applicationDirectory = manifest.platform === "darwin" ? path.join(application, "Contents", "Resources", "app") : path.join(root, "app");
  const node = manifest.platform === "darwin" ? path.join(application, "Contents", "Frameworks", "node") : path.join(root, "bin", `node${executableSuffix}`);
  let profile = null;
  if (options.requireRuntime) {
    if (manifest.releaseReady !== true) {
      throw new Error("provider-host runtime verification requires a release-ready archive");
    }
    const nativeTarget = (manifest.platform === "darwin" && process.platform === "darwin" &&
      ((manifest.architecture === "arm64" && process.arch === "arm64") || (manifest.architecture === "amd64" && process.arch === "x64"))) ||
      (manifest.platform === "linux" && process.platform === "linux" && ((manifest.architecture === "amd64" && process.arch === "x64") || (manifest.architecture === "arm64" && process.arch === "arm64"))) ||
      (manifest.platform === "windows" && manifest.architecture === "amd64" && process.platform === "win32" && process.arch === "x64");
    if (!nativeTarget) throw new Error("provider-host runtime verification requires the matching target host");
    const hostVersion = await command(host, ["version"], { capture: true, captureLimit: 4096 });
    const updaterVersion = await command(updater, ["version"], { capture: true, captureLimit: 4096 });
    const menuVersion = menu ? await command(menu, ["version"], { capture: true, captureLimit: 4096 }) : null;
    if (hostVersion !== manifest.version ||
      updaterVersion !== manifest.version || (menu && menuVersion !== manifest.version)) {
      throw new Error("provider-host binary versions do not match the manifest");
    }
    await command(node, ["--eval", betterSQLiteSmokeTest], { cwd: applicationDirectory });
    const doctor = JSON.parse(await command(host, ["doctor"], { capture: true, captureLimit: 64 * 1024 }));
    if (doctor.schema_version !== "multivibe-host-doctor-v1" || doctor.version !== manifest.version ||
      doctor.bundle !== "valid" || doctor.platform?.supported !== true) {
      throw new Error("provider-host doctor did not confirm the bundle and hardware");
    }
    profile = null;
  }
  return { manifest, profile };
}

async function validateMacDiskImage(diskImage, work, options) {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) {
    throw new Error("provider-host macOS disk image verification requires macOS");
  }
  const mount = path.join(work, "mounted");
  await mkdir(mount, { mode: 0o700 });
  let mounted = false;
  try {
    await command("hdiutil", ["attach", "-quiet", "-readonly", "-nobrowse", "-mountpoint", mount, diskImage]);
    mounted = true;
    const entries = (await readdir(mount, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    const allowedEntries = new Set([".background", ".DS_Store", ".fseventsd", "Applications", "MultiVibe Host.app"]);
    if (entries.some((entry) => !allowedEntries.has(entry.name))) {
      throw new Error("provider-host disk image contains an unexpected root entry");
    }
    const visibleEntries = entries.filter((entry) => !entry.name.startsWith("."));
    if (visibleEntries.length !== 2 || visibleEntries[0].name !== "Applications" || !visibleEntries[0].isSymbolicLink() ||
      visibleEntries[1].name !== "MultiVibe Host.app" || !visibleEntries[1].isDirectory() || visibleEntries[1].isSymbolicLink()) {
      throw new Error("provider-host disk image must expose only MultiVibe Host.app and the Applications shortcut");
    }
    if (await readlink(path.join(mount, "Applications")) !== "/Applications") {
      throw new Error("provider-host disk image Applications shortcut is invalid");
    }
    const backgroundPath = path.join(mount, ".background", "dmg-background.png");
    const backgroundInfo = await lstat(backgroundPath);
    const background = await readFile(backgroundPath);
    if (!backgroundInfo.isFile() || backgroundInfo.isSymbolicLink() || backgroundInfo.size < 24 ||
      backgroundInfo.size > 2 * 1024 * 1024 || !background.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      background.readUInt32BE(16) !== 720 || background.readUInt32BE(20) !== 440) {
      throw new Error("provider-host disk image background is invalid");
    }
    const application = path.join(mount, "MultiVibe Host.app");
    const metadata = JSON.parse(await readFile(path.join(application, "Contents", "Resources", "provider-host-release.json"), "utf8"));
    if (!exactKeys(metadata, ["schemaVersion", "product", "version", "sourceCommit", "platform", "architecture",
      "sourceTreeDirty", "releaseReady", "macOSSignature"]) || metadata.schemaVersion !== 1 ||
      metadata.product !== "multivibe-host" || typeof metadata.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(metadata.version) ||
      typeof metadata.sourceCommit !== "string" || !/^[a-f0-9]{40}$/u.test(metadata.sourceCommit) ||
      metadata.platform !== "darwin" || !["arm64", "amd64"].includes(metadata.architecture) ||
      typeof metadata.sourceTreeDirty !== "boolean" || typeof metadata.releaseReady !== "boolean" ||
      !["unsigned-development", "developer-id", "developer-id-notarized"].includes(metadata.macOSSignature) ||
      metadata.releaseReady !== (!metadata.sourceTreeDirty && metadata.macOSSignature === "developer-id-notarized")) {
      throw new Error("provider-host disk image release metadata is invalid");
    }
    const plistVersion = await command("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-",
      path.join(application, "Contents", "Info.plist")], { capture: true, captureLimit: 4096 });
    const bundleIdentifier = await command("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-",
      path.join(application, "Contents", "Info.plist")], { capture: true, captureLimit: 4096 });
    const bundleExecutable = await command("plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-",
      path.join(application, "Contents", "Info.plist")], { capture: true, captureLimit: 4096 });
    const bundleIcon = await command("plutil", ["-extract", "CFBundleIconFile", "raw", "-o", "-",
      path.join(application, "Contents", "Info.plist")], { capture: true, captureLimit: 4096 });
    const menuBarOnly = await command("plutil", ["-extract", "LSUIElement", "raw", "-o", "-",
      path.join(application, "Contents", "Info.plist")], { capture: true, captureLimit: 4096 });
    const minimumSystemVersion = await command("plutil", ["-extract", "LSMinimumSystemVersion", "raw", "-o", "-",
      path.join(application, "Contents", "Info.plist")], { capture: true, captureLimit: 4096 });
    const workerHandoffScheme = await command("plutil", ["-extract", "CFBundleURLTypes.0.CFBundleURLSchemes.0", "raw", "-o", "-",
      path.join(application, "Contents", "Info.plist")], { capture: true, captureLimit: 4096 });
    if (plistVersion !== metadata.version || bundleIdentifier !== "cloud.multivibe.host" ||
      bundleExecutable !== "MultiVibe Host" || bundleIcon !== "MultiVibe.icns" || menuBarOnly !== "false" ||
      minimumSystemVersion !== "13.0" || workerHandoffScheme !== "multivibe") {
      throw new Error("provider-host disk image application identity is invalid");
    }
    if (metadata.macOSSignature !== "unsigned-development") {
      await command("codesign", ["--verify", "--deep", "--strict", "--verbose=2", application]);
      const signatureDetails = await command("codesign", ["-d", "--verbose=4", application], {
        capture: true, captureStderr: true, captureLimit: 64 * 1024,
      });
      if (!signatureDetails.split("\n").some((line) => line.trim() === `TeamIdentifier=${expectedAppleTeamIdentifier}`)) {
        throw new Error("provider-host disk image application TeamIdentifier is invalid");
      }
    }
    if (metadata.macOSSignature === "developer-id-notarized") {
      await command("codesign", ["--verify", "--strict", "--verbose=2", diskImage]);
      await runMacStapler("validate", diskImage, command);
      await runMacStapler("validate", application, command);
      await command("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", diskImage]);
      await command("spctl", ["--assess", "--type", "execute", "--verbose=2", application]);
    }
    if (options.requireRuntime) {
      if (!metadata.releaseReady) throw new Error("provider-host runtime verification requires a release-ready disk image");
      for (const [relative, label] of [
        ["Contents/MacOS/multivibe-host", "host"],
      ]) {
        const version = await command(path.join(application, relative), ["version"], { capture: true, captureLimit: 4096 });
        if (version !== metadata.version) throw new Error(`provider-host disk image ${label} version is invalid`);
      }
      await command(path.join(application, "Contents", "Frameworks", "node"), ["--eval", betterSQLiteSmokeTest], {
        cwd: path.join(application, "Contents", "Resources", "app"),
      });
    }
    return metadata;
  } finally {
    if (mounted) await command("hdiutil", ["detach", "-quiet", mount]);
  }
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  let work = null;
  let root = options.directory;
  let archiveInspection = null;
  let verifiedArchiveSha256 = null;
  try {
    if (options.archive) {
      const inputInfo = await lstat(options.archive);
      if (!inputInfo.isFile() || inputInfo.isSymbolicLink() || inputInfo.size < 1 || inputInfo.size > maximumArchiveBytes) {
        throw new Error("provider-host archive is invalid or exceeds the verification ceiling");
      }
      work = await mkdtemp(path.join(tmpdir(), "multivibe-host-verify-"));
      await chmod(work, 0o700);
      const extension = options.archive.endsWith(".dmg") ? ".dmg" : options.archive.endsWith(".zip") ? ".zip" :
        options.archive.endsWith(".tar.gz") ? ".tar.gz" : null;
      if (extension === null) throw new Error("provider-host archive format is unsupported");
      const archiveCopy = path.join(work, `input${extension}`);
      await copyFile(options.archive, archiveCopy);
      await chmod(archiveCopy, 0o600);
      const copiedInfo = await lstat(archiveCopy);
      if (!copiedInfo.isFile() || copiedInfo.isSymbolicLink() || copiedInfo.size < 1 || copiedInfo.size > maximumArchiveBytes) {
        throw new Error("provider-host private archive copy is invalid or exceeds the verification ceiling");
      }
      verifiedArchiveSha256 = await sha256(archiveCopy);
      if (extension === ".dmg") {
        const manifest = await validateMacDiskImage(archiveCopy, work, options);
        console.log(JSON.stringify({
          verified: true,
          archive: options.archive,
          directory: null,
          archiveSha256: verifiedArchiveSha256,
          version: manifest.version,
          sourceCommit: manifest.sourceCommit,
          sourceTreeDirty: manifest.sourceTreeDirty,
          releaseReady: manifest.releaseReady,
          platform: manifest.platform,
          architecture: manifest.architecture,
          runtimeChecked: options.requireRuntime,
          profile: null,
        }));
        return;
      }
      archiveInspection = await inspectArchive(archiveCopy);
      const extraction = path.join(work, "extracted");
      await mkdir(extraction, { mode: 0o700 });
      if (extension === ".zip") await extractZipArchive(archiveCopy, extraction);
      else await command("tar", ["-xzf", archiveCopy, "-C", extraction]);
      const entries = await readdir(extraction, { withFileTypes: true });
      if (entries.length !== 1 || !entries[0].isDirectory() || entries[0].isSymbolicLink()) {
        throw new Error("provider-host archive root is invalid");
      }
      root = path.join(extraction, entries[0].name);
    }
    const { manifest, profile } = await validateTree(root, options, archiveInspection);
    console.log(JSON.stringify({
      verified: true,
      archive: options.archive ?? null,
      directory: options.directory ?? null,
      archiveSha256: verifiedArchiveSha256,
      version: manifest.version,
      sourceCommit: manifest.sourceCommit,
      sourceTreeDirty: manifest.sourceTreeDirty,
      releaseReady: manifest.releaseReady,
      platform: manifest.platform,
      architecture: manifest.architecture,
      runtimeChecked: options.requireRuntime,
      profile,
    }));
  } finally {
    if (work) await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`provider-host verification failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
