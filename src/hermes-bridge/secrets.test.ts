import assert from "node:assert/strict";
import fs, { mkdtemp, readFile, stat, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "./cli.js";
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

test("enrollment persists the Access service token it used to get through", async () => {
  // `enroll` accepted --access-id/--access-secret to reach a gated exchange and
  // then stored only the edge key. Every later inference request was therefore
  // anonymous, Cloudflare answered 302, and `nous-first` served the whole
  // conversation from Nous while the edge was healthy.
  //
  // The exchange payload deliberately carries no Access values (the edge never
  // mints them), so this asserts the operator's arguments are what get stored.
  const previous = process.env.MULTIVIBE_BRIDGE_STATE_DIR;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-enroll-"));
  const secretFile = path.join(directory, "access-secret");
  process.env.MULTIVIBE_BRIDGE_STATE_DIR = directory;
  try {
    await fs.writeFile(secretFile, "s3cret-value\n", { mode: 0o600 });
    const responses = [
      // POST /hermes-bridge/enrollment/exchange
      new Response(
        JSON.stringify({
          object: "multivibe.hermes-bridge.enrollment",
          application: "hermes-test",
          edgeApiKey: "mvhb_test_key",
          mappings: [{ from: "m", edge: "m", nous: "m" }],
          expiresAt: Date.now() + 60_000,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      responses.shift() ?? new Response("{}", { status: 500 })) as typeof fetch;
    // `main` picks the backend from `process.platform`, and on macOS that is
    // the login Keychain: a test must never write there. Posing as Linux makes
    // `resolveBackend` probe `secret-tool`, which is absent here, so it lands on
    // the same 0600 file backend the enrollment test then reads.
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const code = await main([
        "enroll",
        "--code",
        "mvenr_" + "a".repeat(64),
        "--edge",
        "https://multivibe.example",
        "--access-id",
        "abc123",
        "--access-secret",
        secretFile,
      ]);
      assert.equal(code, 0);
    } finally {
      globalThis.fetch = originalFetch;
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    }

    // Read back through the file backend explicitly: `main` chose the backend
    // for this host, and on macOS that is the login Keychain, which a test must
    // not write to. Overriding XDG_DATA_HOME is not enough either, so the
    // assertion targets the same directory `stateDirectory()` resolved.
    const backend = fileBackend(directory);
    const stored = await loadSecrets(backend);
    assert.equal(stored.secrets.edgeApiKey, "mvhb_test_key");
    // The id is normalized with the suffix Cloudflare requires.
    assert.equal(stored.secrets.accessClientId, "abc123.access");
    // The trailing newline of a `printf`-written file must not poison the header.
    assert.equal(stored.secrets.accessClientSecret, "s3cret-value");
  } finally {
    if (previous === undefined) delete process.env.MULTIVIBE_BRIDGE_STATE_DIR;
    else process.env.MULTIVIBE_BRIDGE_STATE_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
