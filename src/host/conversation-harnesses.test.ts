import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { HostConversationHarnessManager } from "./conversation-harnesses.js";
import { HOST_HARNESS_DEFINITIONS, HostHarnessIntegrationManager } from "./harness-integrations.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "multivibe-conversation-harness-"));
  const hermes = path.join(root, "hermes");
  const pi = path.join(root, "pi");
  await writeFile(hermes, `#!/usr/bin/env node
const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>{
 if(process.argv.includes(chunks.join('')))process.exit(9);
 if(!process.argv.includes('--toolsets')||!process.argv.includes('memory'))process.exit(8);
 console.log(JSON.stringify({type:'system',session_id:'hermes-session'}));
 console.log(JSON.stringify({type:'text',text:'Bon'}));
 console.log(JSON.stringify({type:'text',text:'jour'}));
 console.log(JSON.stringify({type:'result',exit_code:0,session_id:'hermes-session'}));
});\n`);
  await writeFile(pi, `#!/usr/bin/env node
const fs=require('node:fs');const s=process.argv[process.argv.indexOf('--session')+1];fs.appendFileSync(s,'turn\\n');
let b='';process.stdin.on('data',c=>{b+=c;for(;;){const i=b.indexOf('\\n');if(i<0)break;const e=JSON.parse(b.slice(0,i));b=b.slice(i+1);
 if(e.type==='get_state')console.log(JSON.stringify({type:'response',command:'get_state',success:true}));
 if(e.type==='prompt'){console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Pi'}}));console.log(JSON.stringify({type:'agent_end'}));}
}});\n`);
  await Promise.all([chmod(hermes, 0o755), chmod(pi, 0o755)]);
  const integration = {
    list: async () => [
      { id: "hermes-agent", name: "Hermes Agent", detected: true, configured: true },
      { id: "pi", name: "Pi", detected: true, configured: true },
    ],
    executablePath: async (id: string) => id === "hermes-agent" ? hermes : id === "pi" ? pi : null,
  } as unknown as HostHarnessIntegrationManager;
  return { root, manager: new HostConversationHarnessManager(integration, path.join(root, "sessions")) };
}

test("detected structured harnesses expose honest conversation capabilities", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const list = await f.manager.list();
  assert.deepEqual(list.map((entry) => [entry.id, entry.available]), [["native", true], ["hermes-agent", true], ["pi", true]]);
  assert.equal(list[1].capabilities.longTermMemory, true);
  assert.equal(list[2].capabilities.longTermMemory, false);
});

test("the conversation catalog exposes every known harness in editorial popularity order", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "multivibe-full-harness-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const integrations = new HostHarnessIntegrationManager({
    homeDirectory: root,
    statePath: path.join(root, "state.json"),
    baseUrl: "http://127.0.0.1:1455",
    executableDirectories: [],
  });
  const manager = new HostConversationHarnessManager(integrations, path.join(root, "sessions"));
  const catalog = await manager.list();
  assert.equal(catalog.length, HOST_HARNESS_DEFINITIONS.length + 1);
  assert.deepEqual(catalog.slice(0, 8).map((entry) => entry.name), [
    "MultiVibe natif", "Claude Code", "OpenAI Codex", "OpenCode", "OpenClaw", "Hermes Agent", "Pi", "Goose",
  ]);
  assert.deepEqual(catalog.map((entry) => entry.popularityRank), [0, ...catalog.slice(1).map((_, index) => index + 2)]);
  assert.equal(catalog.find((entry) => entry.id === "claude-code")?.conversationCapable, false);
});

test("compatible missing harnesses remain visible and use only the pinned installer", { skip: process.platform !== "darwin" }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "multivibe-conversation-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const marker = path.join(root, "pi-installed");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
  const npm = path.join(bin, "npm");
  await writeFile(npm, `#!/bin/sh\necho downloading-pi\ntouch '${marker}'\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  t.after(() => { process.env.PATH = previousPath; });
  const integration = {
    list: async () => [],
    get: async (id: string) => ({ id, name: "Pi", detected: await stat(marker).then(() => true, () => false), configured: false }),
    executablePath: async () => null,
  } as unknown as HostHarnessIntegrationManager;
  const manager = new HostConversationHarnessManager(integration, path.join(root, "sessions"));
  const list = await manager.list();
  assert.deepEqual(list.map((entry) => entry.id), ["native", "hermes-agent", "pi"]);
  assert.equal(list[2].canInstall, true);
  const logs: string[] = [];
  await manager.install("pi", new AbortController().signal, (line) => logs.push(line));
  assert.deepEqual(logs, ["Installing Pi 0.73.1…", "downloading-pi", "Pi installed successfully."]);
});

test("Hermes receives the prompt on stdin and returns its durable session", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const updates: string[] = [];
  const result = await f.manager.run({ harnessId: "hermes-agent", conversationId: "11111111-1111-4111-8111-111111111111",
    prompt: "$(never-shell-evaluate)", model: "gpt-test" }, new AbortController().signal, (text) => updates.push(text));
  assert.deepEqual(updates, ["Bon", "Bonjour"]);
  assert.deepEqual(result, { text: "Bonjour", sessionId: "hermes-session" });
});

test("Pi runs through RPC with an isolated persistent session", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const result = await f.manager.run({ harnessId: "pi", conversationId: "22222222-2222-4222-8222-222222222222",
    prompt: "Bonjour", model: "gpt-test" }, new AbortController().signal, () => undefined);
  assert.equal(result.text, "Pi");
  const entries = await readdir(path.join(f.root, "sessions"));
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^pi-[0-9a-f]{64}\.jsonl$/u);
});

test("invalid model and conversation inputs never reach a process", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await assert.rejects(f.manager.run({ harnessId: "pi", conversationId: "../escape", prompt: "x", model: "bad model" },
    new AbortController().signal, () => undefined), /Invalid harness model|Invalid conversation id/);
});
