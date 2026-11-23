import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SCRIPT = "scripts/hermes-enrollment-prompt.mjs";
const CODE = `mvenr_${"a".repeat(64)}`;

function run(args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

function runFailing(args) {
  try {
    run(args);
  } catch (error) {
    return String(error.stderr ?? "");
  }
  throw new Error("expected the script to fail");
}

test("the rendered prompt has no placeholder left", () => {
  const rendered = run([
    "--code", CODE,
    "--edge", "https://host.example.invalid",
    "--model", "deepseek-v4.1-flash",
    "--access-id", "abc123",
    "--access-secret-path", "/home/client/.access-secret",
  ]);
  assert.doesNotMatch(rendered, /\{\{[A-Z_]+\}\}/u);
  assert.match(rendered, new RegExp(CODE, "u"));
  assert.match(rendered, /deepseek-v4\.1-flash/u);
  assert.match(rendered, /abc123/u);
  assert.match(rendered, /\/home\/client\/\.access-secret/u);
});

test("an edge URL ending in /v1 is reduced to the enrollment base", () => {
  // The prompt must show the surface the exchange lives on. A `/v1` there is a
  // 404 that a client would report as our bug.
  const rendered = run([
    "--code", CODE,
    "--edge", "https://host.example.invalid/v1",
    "--model", "m",
  ]);
  assert.match(rendered, /--edge https:\/\/host\.example\.invalid\b/u);
  assert.doesNotMatch(rendered, /--edge https:\/\/[^\s]*\/v1\b/u);
});

test("a code that is not an enrollment code is refused", () => {
  const error = runFailing(["--code", "not-a-code", "--edge", "https://h", "--model", "m"]);
  assert.match(error, /mvenr_/u);
});

test("an Access id without where its secret lives is refused", () => {
  // Half a pair would put a value in the prompt that the client cannot use, and
  // would suggest the secret itself belongs in the text.
  const error = runFailing([
    "--code", CODE,
    "--edge", "https://h",
    "--model", "m",
    "--access-id", "abc123",
  ]);
  assert.match(error, /access-secret-path/u);
});

test("--out writes a private file and prints only its path", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-prompt-"));
  const out = path.join(directory, "prompt.md");
  const stdout = run([
    "--code", CODE,
    "--edge", "https://h",
    "--model", "m",
    "--out", out,
  ]);
  assert.equal(stdout.trim(), out);
  const mode = fs.statSync(out).mode & 0o777;
  // The prompt carries a live enrollment code: it must not be world-readable.
  assert.equal(mode, 0o600);
  assert.match(fs.readFileSync(out, "utf8"), new RegExp(CODE, "u"));
  fs.rmSync(directory, { recursive: true, force: true });
});
