/**
 * Zero-dependency operator surface:
 *
 *   multivibe-hermes-bridge enroll --code mvenr_... [--nous-key -]
 *   multivibe-hermes-bridge run
 *   multivibe-hermes-bridge doctor
 *   multivibe-hermes-bridge print-key
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import type { BridgeConfig, BridgeSecrets, ModelMapping } from "./config.js";
import { DEFAULT_BRIDGE_CONFIG } from "./config.js";
import { runDoctor } from "./doctor.js";
import { exchangeEnrollment, parseEnrollmentCode } from "./enroll.js";
import { createBridge } from "./server.js";
import { loadSecrets, resolveBackend, storeSecrets } from "./secrets.js";

const USAGE = `Usage: multivibe-hermes-bridge <command>

Commands:
  enroll --code <mvenr_...>   Exchange a one-time code and store the credentials
  run                         Start the local bridge
  doctor                      Verify connectivity and configuration
  print-key                   Print the key the harness must present

Options:
  --mode nous-first|edge-first|nous-only|edge-only   (default: nous-first)
  --port <port>               (default: 8787)
  --edge <url>                Override the MultiVibe inference base URL
  --enroll <url>              Override the enrollment base URL (no /v1)
  --nous <url>                Override the Nous Research base URL
  --nous-key <path|->         Read the Nous API key from a file, or stdin
  --json                      Machine-readable output
`;

export type ParsedArgs = {
  command: string;
  values: Map<string, string>;
  flags: Set<string>;
};

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = "", ...rest] = argv;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.add(name);
      continue;
    }
    values.set(name, next);
    index += 1;
  }
  return { command, values, flags };
}

/** Private state directory. Never inside the project checkout or the cwd. */
export function stateDirectory(platform: NodeJS.Platform = process.platform): string {
  if (process.env.MULTIVIBE_BRIDGE_STATE_DIR) return process.env.MULTIVIBE_BRIDGE_STATE_DIR;
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "MultiVibe Hermes Bridge");
  }
  const dataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "multivibe-hermes-bridge");
}

const MODES = ["nous-first", "edge-first", "nous-only", "edge-only"] as const;

export async function loadConfig(args: ParsedArgs): Promise<BridgeConfig> {
  const directory = stateDirectory();
  let stored: Partial<BridgeConfig> = {};
  try {
    stored = JSON.parse(
      await fs.readFile(path.join(directory, "config.json"), "utf8"),
    ) as Partial<BridgeConfig>;
  } catch {
    /* first run */
  }
  const mode = args.values.get("mode") ?? stored.mode ?? DEFAULT_BRIDGE_CONFIG.mode;
  if (!MODES.includes(mode as (typeof MODES)[number])) {
    throw new Error(`invalid --mode '${mode}'`);
  }
  const port = Number(args.values.get("port") ?? stored.port ?? DEFAULT_BRIDGE_CONFIG.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid --port");
  const edge = args.values.get("edge");
  const enroll = args.values.get("enroll");
  const nous = args.values.get("nous");
  return {
    ...DEFAULT_BRIDGE_CONFIG,
    ...stored,
    mode: mode as BridgeConfig["mode"],
    port,
    mappings: stored.mappings ?? [],
    ...(edge ? { edgeBaseUrl: edge } : {}),
    // `--edge` is the only URL an operator normally supplies, so the enrollment
    // base follows it unless it is given explicitly. Without this the command
    // silently targets production while the operator pointed at a test edge.
    ...(enroll
      ? { enrollBaseUrl: enroll }
      : edge
        ? { enrollBaseUrl: edge.replace(/\/+$/, "").replace(/\/v1$/i, "") }
        : {}),
    ...(nous ? { nousBaseUrl: nous } : {}),
  };
}

/** Read a secret from stdin or a file. Never from an argument: it leaks in `ps`. */
export async function readSecretInput(source: string): Promise<string> {
  if (source === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  return (await fs.readFile(source, "utf8")).trim();
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (!args.command || args.flags.has("help") || args.command === "help") {
    process.stdout.write(USAGE);
    return args.command ? 0 : 1;
  }
  const json = args.flags.has("json");
  const directory = stateDirectory();
  const config = await loadConfig(args);
  const backend = await resolveBackend(process.platform, directory);

  if (args.command === "enroll") {
    const raw = args.values.get("code");
    const code = raw ? parseEnrollmentCode(raw) : undefined;
    if (!code) {
      process.stderr.write("A valid --code mvenr_... value is required.\n");
      return 2;
    }
    const result = await exchangeEnrollment({ endpoint: config.enrollBaseUrl, code });
    if (!result.ok) {
      process.stderr.write(`Enrollment failed: ${result.reason}.\n`);
      return 1;
    }
    await storeSecrets(backend, {
      edgeApiKey: result.payload.edgeApiKey,
      ...(result.payload.accessClientId ? { accessClientId: result.payload.accessClientId } : {}),
      ...(result.payload.accessClientSecret
        ? { accessClientSecret: result.payload.accessClientSecret }
        : {}),
    });
    // The Nous key is the client's own: read locally, never uploaded.
    const nousSource = args.values.get("nous-key");
    if (nousSource) {
      const nousKey = await readSecretInput(nousSource);
      if (nousKey) await storeSecrets(backend, { nousApiKey: nousKey });
    }
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const mappings: ModelMapping[] = result.payload.mappings ?? config.mappings;
    await fs.writeFile(
      path.join(directory, "config.json"),
      JSON.stringify({ ...config, mappings }, null, 2),
      { mode: 0o600 },
    );
    process.stdout.write(
      json
        ? `${JSON.stringify({ ok: true, mappings: mappings.length, secrets: backend.kind })}\n`
        : `Enrolled. ${mappings.length} model mapping(s) stored in ${directory} (secrets: ${backend.kind}).\n`,
    );
    return 0;
  }

  const stored = await loadSecrets(backend);
  // `loadSecrets` guarantees a key string; the rest stay optional.
  const secrets: BridgeSecrets = {
    ...stored.secrets,
    edgeApiKey: stored.secrets.edgeApiKey ?? "",
  };

  if (args.command === "print-key") {
    if (!stored.localKey) {
      process.stderr.write("No local key yet. Run `run` once to create it.\n");
      return 1;
    }
    process.stdout.write(`${stored.localKey}\n`);
    return 0;
  }

  if (args.command === "doctor") {
    const report = await runDoctor({ config, secrets, mappings: config.mappings });
    if (json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      for (const check of report.checks) {
        process.stdout.write(`${check.status.toUpperCase().padEnd(8)} ${check.name}: ${check.detail}\n`);
      }
      process.stdout.write(report.ok ? "\nAll checks passed.\n" : "\nSome checks failed.\n");
    }
    return report.ok ? 0 : 1;
  }

  if (args.command === "run") {
    // Reuse the persisted key so a restart does not invalidate the harness's
    // `.env`. Mint one only on the very first start.
    const bridge = createBridge({
      config,
      secrets,
      mappings: config.mappings,
      ...(stored.localKey ? { localKey: stored.localKey } : {}),
      log: (event) => {
        // One JSON line per event, content-free by construction.
        process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
      },
    });
    if (!stored.localKey) {
      await backend.write("localKey", bridge.localKey);
      process.stdout.write(
        "Generated a loopback key. Run `print-key` and put it in ~/.hermes/.env.\n",
      );
    }
    await new Promise<void>((resolve, reject) => {
      bridge.server.once("error", reject);
      bridge.server.listen(config.port, config.host, () => {
        const address = `http://${config.host}:${config.port}/v1`;
        process.stdout.write(
          `MultiVibe Hermes bridge listening on ${address} (mode ${config.mode}).\n` +
            `Point the harness at ${address} with the key from \`print-key\`.\n`,
        );
        resolve();
      });
    });
    const shutdown = () => {
      bridge.server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3_000).unref();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    await new Promise(() => undefined);
  }

  process.stderr.write(`Unknown command '${args.command}'.\n\n${USAGE}`);
  return 2;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().then(
    (code) => {
      if (code !== 0) process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}
