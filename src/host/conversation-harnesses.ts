import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { HostHarnessIntegrationManager } from "./harness-integrations.js";

const MAX_PROMPT_CHARACTERS = 32_000;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const RUN_TIMEOUT_MS = 5 * 60_000;
const SAFE_MODEL = /^[^\u0000-\u001f\u007f\s]{1,256}$/u;
const SAFE_SESSION = /^[0-9A-Za-z._:-]{1,256}$/u;
const HARNESS_ENVIRONMENT_KEYS = ["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG", "LC_ALL", "SHELL"] as const;

function harnessEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NO_COLOR: "1", TERM: "dumb" };
  for (const key of HARNESS_ENVIRONMENT_KEYS) if (process.env[key]) environment[key] = process.env[key];
  return environment;
}

export type ConversationHarnessView = {
  id: "native" | "hermes-agent" | "pi";
  name: string;
  available: boolean;
  configured: boolean;
  description: string;
  capabilities: { sessions: boolean; streaming: boolean; tools: boolean; longTermMemory: boolean };
  unavailableReason?: string;
};

export type ConversationHarnessRun = {
  harnessId: "hermes-agent" | "pi";
  conversationId: string;
  prompt: string;
  model: string;
  sessionId?: string;
};

export type ConversationHarnessResult = { text: string; sessionId?: string };

export class ConversationHarnessError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "ConversationHarnessError";
  }
}

type SpawnHarness = typeof spawn;

export class HostConversationHarnessManager {
  constructor(
    private readonly integrations: HostHarnessIntegrationManager,
    private readonly sessionDirectory: string,
    private readonly spawnHarness: SpawnHarness = spawn,
  ) {}

  async list(): Promise<ConversationHarnessView[]> {
    const detected = new Map((await this.integrations.list()).map((entry) => [entry.id, entry]));
    const native: ConversationHarnessView = {
      id: "native", name: "MultiVibe natif", available: true, configured: true,
      description: "Conversation directe avec le modèle sélectionné.",
      capabilities: { sessions: true, streaming: true, tools: false, longTermMemory: false },
    };
    const ids = (["hermes-agent", "pi"] as const).filter((id) => detected.get(id)?.detected);
    const supported = await Promise.all(ids.map(async (id): Promise<ConversationHarnessView> => {
      const entry = detected.get(id);
      const executable = entry?.detected ? await this.integrations.executablePath(id) : null;
      const available = Boolean(entry?.detected && entry.configured && executable);
      const memory = id === "hermes-agent";
      return {
        id,
        name: id === "hermes-agent" ? "Hermes Agent" : "Pi",
        available,
        configured: Boolean(entry?.configured),
        description: memory
          ? "Sessions Hermes avec mémoire longue durée et consolidation configurées sur ce Mac."
          : "Sessions Pi persistantes avec orchestration et compaction du contexte.",
        capabilities: { sessions: true, streaming: true, tools: memory, longTermMemory: memory },
        ...(!available ? { unavailableReason: !entry?.detected
          ? "Non installé sur ce Mac."
          : !entry.configured ? "Détecté, mais pas connecté à MultiVibe."
          : "Exécutable introuvable dans un emplacement sûr." } : {}),
      };
    }));
    return [native, ...supported];
  }

  async run(input: ConversationHarnessRun, signal: AbortSignal, update: (text: string) => void): Promise<ConversationHarnessResult> {
    const prompt = input.prompt.trim();
    if (!prompt || prompt.length > MAX_PROMPT_CHARACTERS) throw new ConversationHarnessError("Invalid harness prompt");
    if (!SAFE_MODEL.test(input.model)) throw new ConversationHarnessError("Invalid harness model");
    if (!/^[0-9a-f-]{36}$/iu.test(input.conversationId)) throw new ConversationHarnessError("Invalid conversation id");
    if (input.sessionId && !SAFE_SESSION.test(input.sessionId)) throw new ConversationHarnessError("Invalid harness session id");
    const available = (await this.list()).find((entry) => entry.id === input.harnessId);
    if (!available?.available) throw new ConversationHarnessError(available?.unavailableReason ?? "Harness unavailable", 409);
    const executable = await this.integrations.executablePath(input.harnessId);
    if (!executable) throw new ConversationHarnessError("Harness executable unavailable", 409);
    await fs.mkdir(this.sessionDirectory, { recursive: true, mode: 0o700 });
    return input.harnessId === "hermes-agent"
      ? this.runHermes(executable, input, signal, update)
      : this.runPi(executable, input, signal, update);
  }

  private runHermes(executable: string, input: ConversationHarnessRun, signal: AbortSignal, update: (text: string) => void) {
    const args = ["chat", "--query-file", "-", "--oneshot", "--format", "stream-json", "--provider", "openai",
      "--model", input.model, "--toolsets", "memory", "--max-turns", "16", "--run-budget", "180"];
    if (input.sessionId) args.push("--resume", input.sessionId, "--no-restore-cwd");
    return this.consumeProcess(executable, args, input.prompt, signal, (event, state) => {
      if (event.type === "text" && typeof event.text === "string") {
        state.text += event.text; update(state.text);
      }
      if (event.type === "system" && typeof event.session_id === "string") state.sessionId = event.session_id;
      if (event.type === "result") {
        if (typeof event.session_id === "string") state.sessionId = event.session_id;
        if (event.exit_code !== 0) throw new ConversationHarnessError("Hermes could not complete this turn", 502);
        state.done = true;
      }
    });
  }

  private async runPi(executable: string, input: ConversationHarnessRun, signal: AbortSignal, update: (text: string) => void) {
    const key = createHash("sha256").update(input.conversationId).digest("hex");
    const session = path.join(this.sessionDirectory, `pi-${key}.jsonl`);
    const args = ["--mode", "rpc", "--session", session, "--provider", "multivibe", "--model", input.model,
      "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates"];
    return this.consumeProcess(executable, args, undefined, signal, (event, state, child) => {
      if (event.type === "response" && event.command === "get_state") {
        child.stdin.write(`${JSON.stringify({ type: "prompt", message: input.prompt })}\n`);
      }
      if (event.type === "message_update") {
        const assistant = event.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
        if (assistant?.type === "text_delta" && typeof assistant.delta === "string") {
          state.text += assistant.delta; update(state.text);
        }
      }
      if (event.type === "agent_end") state.done = true;
      if (event.type === "response" && event.success === false) throw new ConversationHarnessError("Pi rejected this turn", 502);
    }, (child) => child.stdin.write(`${JSON.stringify({ type: "get_state" })}\n`));
  }

  private consumeProcess(
    executable: string,
    args: string[],
    stdin: string | undefined,
    signal: AbortSignal,
    consume: (event: Record<string, unknown>, state: { text: string; sessionId?: string; done: boolean }, child: ChildProcessWithoutNullStreams) => void,
    started?: (child: ChildProcessWithoutNullStreams) => void,
  ): Promise<ConversationHarnessResult> {
    return new Promise((resolve, reject) => {
      const child = this.spawnHarness(executable, args, {
        cwd: this.sessionDirectory, env: harnessEnvironment(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
      const state: { text: string; sessionId?: string; done: boolean } = { text: "", done: false };
      let bytes = 0, settled = false, stderrBytes = 0;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timeout); signal.removeEventListener("abort", abort);
        if (!child.killed) {
          child.kill("SIGTERM");
          const force = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 2_000);
          force.unref?.();
        }
        if (error) reject(error);
        else if (!state.done || !state.text.trim()) reject(new ConversationHarnessError("Harness returned no complete response", 502));
        else resolve({ text: state.text, sessionId: state.sessionId });
      };
      const abort = () => finish(new DOMException("Cancelled", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => finish(new ConversationHarnessError("Harness timed out", 504)), RUN_TIMEOUT_MS);
      child.once("error", () => finish(new ConversationHarnessError("Harness could not start", 502)));
      child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; if (stderrBytes > MAX_EVENT_BYTES) finish(new ConversationHarnessError("Harness diagnostics exceeded their limit", 502)); });
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on("line", (line) => {
        if (settled) return;
        bytes += Buffer.byteLength(line);
        if (bytes > MAX_STREAM_BYTES || Buffer.byteLength(line) > MAX_EVENT_BYTES) return finish(new ConversationHarnessError("Harness response exceeded its limit", 502));
        try { consume(JSON.parse(line) as Record<string, unknown>, state, child); }
        catch (error) { finish(error instanceof Error ? error : new ConversationHarnessError("Invalid harness response", 502)); }
        if (state.done) finish();
      });
      child.once("close", () => finish());
      started?.(child);
      if (stdin !== undefined) { child.stdin.end(stdin); }
      if (signal.aborted) abort();
    });
  }
}
