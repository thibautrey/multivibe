import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MANAGED_BLOCK_END,
  MANAGED_BLOCK_START,
  configureHermesEnv,
  stripManagedBlock,
} from "./configure.js";

async function temporaryHome(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "hermes-env-"));
}

const OPTIONS = { model: "deepseek-v4.1-flash", apiKey: "local-key-value" };

test("configure writes the managed block and leaves the rest of the file alone", async (t) => {
  const directory = await temporaryHome();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, ".env");
  await fs.writeFile(
    envPath,
    ["HERMES_CUSTOM=keep-me", "TELEGRAM_BOT_TOKEN=abc", ""].join("\n"),
    { mode: 0o644 },
  );

  const result = await configureHermesEnv({ ...OPTIONS, envPath });
  assert.equal(result.action, "created");

  const written = await fs.readFile(envPath, "utf8");
  // Everything the operator already had survives.
  assert.match(written, /^HERMES_CUSTOM=keep-me$/m);
  assert.match(written, /^TELEGRAM_BOT_TOKEN=abc$/m);
  // And the block is exactly the shape the Host integration looks for.
  assert.match(written, new RegExp(`^${MANAGED_BLOCK_START}$`, "m"));
  assert.match(written, new RegExp(`^${MANAGED_BLOCK_END}$`, "m"));
  assert.match(written, /^LLM_MODEL=deepseek-v4\.1-flash$/m);
  assert.match(written, /^OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:8787\/v1$/m);
  assert.match(written, /^OPENAI_API_KEY=local-key-value$/m);
  // A file holding a key must not be world-readable.
  assert.equal((await fs.stat(envPath)).mode & 0o777, 0o600);
});

test("configure replaces an existing block instead of duplicating it", async (t) => {
  const directory = await temporaryHome();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, ".env");
  await fs.writeFile(
    envPath,
    [
      "KEEP=before",
      MANAGED_BLOCK_START,
      "LLM_MODEL=stale-model",
      "OPENAI_API_KEY=stale-key",
      MANAGED_BLOCK_END,
      "KEEP_AFTER=yes",
      "",
    ].join("\n"),
  );

  const result = await configureHermesEnv({ ...OPTIONS, envPath });
  assert.equal(result.action, "replaced");
  const written = await fs.readFile(envPath, "utf8");
  assert.equal(written.split(MANAGED_BLOCK_START).length - 1, 1, "exactly one block");
  assert.doesNotMatch(written, /stale-model|stale-key/u);
  assert.match(written, /^KEEP=before$/m);
  assert.match(written, /^KEEP_AFTER=yes$/m);
});

test("an unterminated block is refused rather than guessed at", () => {
  // Deleting an undelimited region would silently destroy the operator's config.
  assert.throws(
    () => stripManagedBlock(`KEEP=1\n${MANAGED_BLOCK_START}\nLLM_MODEL=x\n`),
    /never closes/u,
  );
});
