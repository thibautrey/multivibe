/**
 * Write the Hermes configuration block, instead of asking a human to.
 *
 * The enrollment prompt used to tell an operator to open `~/.hermes/.env` and
 * replace the text between two marker lines by hand. That is the one step in the
 * whole flow with no verification: a typo, a lost newline, or a duplicated block
 * silently breaks the harness, and the failure surfaces later as "the model
 * answers strangely" rather than "the config is wrong".
 *
 * This reproduces what the Host already does for its own integrations
 * (`src/host/harness-integrations.ts`): find the block by its markers, replace
 * only what is between them, keep everything else, write atomically at 0600.
 * The markers are shared verbatim so a block written here is later found,
 * updated, and removed by the same code.
 */

import fs from "node:fs/promises";
import path from "node:path";

export const MANAGED_BLOCK_START = "# >>> MultiVibe Host >>>";
export const MANAGED_BLOCK_END = "# <<< MultiVibe Host <<<";

export type ConfigureOptions = {
  /** Absolute path to the harness `.env`. */
  envPath: string;
  model: string;
  /** The loopback key the harness must present to the bridge. */
  apiKey: string;
  /** Bridge base URL, without `/v1`. */
  bridgeBaseUrl?: string;
};

export type ConfigureResult = {
  path: string;
  /** `created` when the file did not exist, `replaced` when a block was rewritten. */
  action: "created" | "replaced";
};

function renderBlock(options: ConfigureOptions): string {
  const base = (options.bridgeBaseUrl ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
  return [
    MANAGED_BLOCK_START,
    "LLM_PROVIDER=openai",
    `LLM_MODEL=${options.model}`,
    `OPENAI_BASE_URL=${base}/v1`,
    `OPENAI_API_KEY=${options.apiKey}`,
    MANAGED_BLOCK_END,
  ].join("\n");
}

/**
 * Remove an existing managed block.
 *
 * An opening marker without its closing marker is refused rather than guessed
 * at: the safe recovery is for a human to look, not for this code to delete a
 * region it cannot delimit.
 */
export function stripManagedBlock(value: string): string {
  const start = value.indexOf(MANAGED_BLOCK_START);
  if (start < 0) return value;
  const end = value.indexOf(MANAGED_BLOCK_END, start);
  if (end < 0) {
    throw new Error(
      `the existing MultiVibe block starts at ${MANAGED_BLOCK_START} but never closes`,
    );
  }
  return `${value.slice(0, start)}${value.slice(end + MANAGED_BLOCK_END.length)}`;
}

export async function configureHermesEnv(options: ConfigureOptions): Promise<ConfigureResult> {
  let current: string | undefined;
  try {
    current = await fs.readFile(options.envPath, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
    current = undefined;
  }
  const hadBlock = current !== undefined && current.includes(MANAGED_BLOCK_START);
  const withoutManaged = stripManagedBlock(current ?? "").trimEnd();
  const prefix = withoutManaged ? `${withoutManaged}\n\n` : "";
  const next = `${prefix}${renderBlock(options)}\n`;

  await fs.mkdir(path.dirname(options.envPath), { recursive: true });
  // Write beside the target then rename, so a crash cannot leave a truncated
  // `.env` that the harness would read as "no API key".
  const temporary = `${options.envPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, next, { mode: 0o600 });
  await fs.rename(temporary, options.envPath);
  await fs.chmod(options.envPath, 0o600);
  return { path: options.envPath, action: hadBlock ? "replaced" : "created" };
}
