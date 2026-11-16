import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { fileBackend, loadSecrets, resolveBackend, storeSecrets } from "./secrets.js";

async function temporaryDirectory(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "mv-bridge-secrets-"));
}

test("a written secret is readable back and survives a new backend instance", async () => {
  const directory = await temporaryDirectory();
  const first = fileBackend(directory);
  await first.write("edgeApiKey", "mv_secret_value");
  // A restart constructs a new backend over the same directory: the value must
  // still be there, or the harness's `.env` points at a bridge that rejects it.
  const second = fileBackend(directory);
  assert.equal(await second.read("edgeApiKey"), "mv_secret_value");
});

test("the fallback file is private, never world-readable", async () => {
  // This file holds the edge API key, the Access service token and the Nous key.
  // On Linux without a secret service it is the only protection there is.
  const directory = await temporaryDirectory();
  await fileBackend(directory).write("edgeApiKey", "mv_secret_value");
  const info = await stat(path.join(directory, "secrets.json"));
  assert.equal(info.mode & 0o777, 0o600, "mode must be exactly 0600");
  assert.equal((await stat(directory)).mode & 0o777, 0o700, "the directory must be private too");
});

test("writing one secret does not erase the others", async () => {
  const directory = await temporaryDirectory();
  const backend = fileBackend(directory);
  await backend.write("edgeApiKey", "edge");
  await backend.write("nousApiKey", "nous");
  await backend.write("accessClientSecret", "access");
  const readBack = JSON.parse(
    await readFile(path.join(directory, "secrets.json"), "utf8"),
  ) as Record<string, string>;
  assert.equal(Object.keys(readBack).length, 3, "all three survive");
});

test("removing a secret leaves the rest intact", async () => {
  const directory = await temporaryDirectory();
  const backend = fileBackend(directory);
  await backend.write("edgeApiKey", "edge");
  await backend.write("nousApiKey", "nous");
  await backend.remove("edgeApiKey");
  assert.equal(await backend.read("edgeApiKey"), undefined);
  assert.equal(await backend.read("nousApiKey"), "nous");
});

test("a corrupt secret file reads as empty rather than crashing the bridge", async () => {
  // The bridge must still start and let `doctor` explain: a truncated file is a
  // recoverable state, not a reason to refuse to run.
  const directory = await temporaryDirectory();
  await writeFile(path.join(directory, "secrets.json"), "{ not json", { mode: 0o600 });
  assert.equal(await fileBackend(directory).read("edgeApiKey"), undefined);
});

test("an absent secret is distinguishable from a supplied blank one", async () => {
  // The distinction is load-bearing: `edgeHeaders` sends the Access pair only
  // when *both* optional values are present, and `doctor` reports a missing key
  // as a failure. A blank string where nothing was stored would blur both.
  const directory = await temporaryDirectory();
  const { secrets } = await loadSecrets(fileBackend(directory));
  // `edgeApiKey` is non-optional in the type, so it is "" — and `Boolean("")`
  // is false, which is exactly how `doctor` reads "not enrolled yet".
  assert.equal(secrets.edgeApiKey, "");
  assert.equal(Boolean(secrets.edgeApiKey), false, "doctor sees no key");
  // The optional ones stay absent, so they cannot be mistaken for credentials.
  assert.equal(secrets.nousApiKey, undefined);
  assert.equal(secrets.accessClientId, undefined);
  assert.equal(secrets.accessClientSecret, undefined);
});

test("storing then loading round-trips every name the bridge uses", async () => {
  const directory = await temporaryDirectory();
  const backend = fileBackend(directory);
  await storeSecrets(backend, {
    edgeApiKey: "edge",
    accessClientId: "id.access",
    accessClientSecret: "secret",
    nousApiKey: "nous",
  });
  const { secrets } = await loadSecrets(backend);
  assert.deepEqual(secrets, {
    edgeApiKey: "edge",
    accessClientId: "id.access",
    accessClientSecret: "secret",
    nousApiKey: "nous",
  });
});

test("an existing file with loose permissions is tightened on the next write", async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, "secrets.json");
  await fileBackend(directory).write("edgeApiKey", "edge");
  await chmod(file, 0o644);
  await fileBackend(directory).write("nousApiKey", "nous");
  assert.equal((await stat(file)).mode & 0o777, 0o600, "rewritten as 0600");
});

test("resolving a backend never throws, so the bridge always starts", async () => {
  const directory = await temporaryDirectory();
  // Linux without a user secret service is the documented fallback path.
  const backend = await resolveBackend("linux", directory);
  assert.equal(backend.kind === "file" || backend.kind === "secret-tool", true);
});
