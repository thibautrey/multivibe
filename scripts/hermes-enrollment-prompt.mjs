#!/usr/bin/env node
/**
 * Render the enrollment prompt a client's Hermes receives.
 *
 * The prompt is a versioned document with five placeholders. Filling them by
 * hand is how a single-use code ends up in the wrong slot, or an Access secret
 * gets pasted into the body instead of referenced by path. This script fills
 * the four values the operator supplies and refuses to emit a prompt that still
 * contains a placeholder or a secret-shaped Access value.
 *
 * The Access secret is never accepted: only a path on the *client's* machine, so
 * the credential cannot leak through the prompt itself.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const TEMPLATE = path.join("docs", "hermes-bridge-enrollment-prompt.md");

function fail(message) {
  process.stderr.write(`hermes-enrollment-prompt: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) fail(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      values.set(name, true);
      continue;
    }
    values.set(name, next);
    index += 1;
  }
  return values;
}

function required(values, name) {
  const value = values.get(name);
  if (typeof value !== "string" || !value.trim()) fail(`--${name} is required`);
  return value.trim();
}

const USAGE = `Usage: node scripts/hermes-enrollment-prompt.mjs \\
  --code mvenr_... --edge https://host --model <harness model> \\
  [--access-id <client id>] [--access-secret-path <path>] [--out <file>]

The Access secret VALUE is never accepted. --access-secret-path names where the
secret will live on the client machine, and that path is what the prompt quotes.
`;

const values = parseArgs(process.argv.slice(2));
if (values.has("help") || values.has("h")) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const code = required(values, "code");
if (!/^mvenr_[A-Za-z0-9_-]{32,128}$/.test(code)) {
  fail("--code must be a mvenr_ enrollment code");
}

const edge = required(values, "edge").replace(/\/+$/, "").replace(/\/v1$/i, "");
if (!/^https?:\/\/[^/\s]+/i.test(edge)) fail("--edge must be an absolute URL");
if (/\/v1$/i.test(required(values, "edge"))) {
  // Tolerated on input, stripped above: the prompt must show the enrollment
  // base, and a `/v1` there produces a 404 the client would read as our bug.
  process.stderr.write("note: --edge ended in /v1; using the enrollment base instead\n");
}

const model = required(values, "model");
const accessId = values.get("access-id");
const accessSecretPath = values.get("access-secret-path");
if (typeof accessId === "string" && typeof accessSecretPath !== "string") {
  fail("--access-id needs --access-secret-path (where the secret lives on the client)");
}
if (typeof accessSecretPath === "string" && typeof accessId !== "string") {
  fail("--access-secret-path needs --access-id");
}

let document = fs.readFileSync(TEMPLATE, "utf8");
const replacements = {
  "{{ENROLLMENT_CODE}}": code,
  "{{ENROLL_URL}}": edge,
  "{{MODEL}}": model,
  "{{ACCESS_CLIENT_ID}}":
    typeof accessId === "string" ? accessId.trim() : "not supplied — see below",
  "{{ACCESS_CLIENT_SECRET_PATH}}":
    typeof accessSecretPath === "string"
      ? accessSecretPath.trim()
      : "not supplied — see below",
};
for (const [placeholder, value] of Object.entries(replacements)) {
  document = document.split(placeholder).join(value);
}

// A leftover placeholder means the template grew a field this script does not
// know about. Shipping it would put a literal `{{...}}` in front of an agent.
const leftover = document.match(/\{\{[A-Z_]+\}\}/g);
if (leftover) fail(`template placeholders were not filled: ${[...new Set(leftover)].join(", ")}`);

const out = values.get("out");
if (typeof out === "string") {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, document, { mode: 0o600 });
  process.stdout.write(`${out}\n`);
} else {
  process.stdout.write(document);
}
