// Real production SwiftUI views against a loopback-only fixture Host. No user data.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { buildAndInstallCef } from './cef-runtime.mjs';
import { resolveMacOSDeveloperDirectory } from './build-macos-native.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), 'multivibe-chat-preview-'));
const now = Date.now();
const supported = { support: 'native', available: true };
const capabilities = Object.fromEntries(['sessions', 'history', 'queue', 'steer', 'interrupt', 'compaction', 'tools', 'skills', 'models', 'commands', 'interactions', 'attachments'].map(key => [key, supported]));
capabilities.queue = { support: 'multivibe', available: true };
capabilities.audio = { support: 'unsupported', available: false, reason: 'Ce harness ne prend pas en charge les fichiers audio.' };
capabilities.memory = { support: 'unknown', available: false };
const descriptor = (id, name, protocol) => ({ id, name, protocol, version: 'preview', detected: true, configured: true, available: true, authentication: 'ready', capabilities });
const catalog = [descriptor('pi', 'Pi', 'pi-rpc'), descriptor('hermes-agent', 'Hermes', 'acp'), descriptor('openai-codex', 'OpenAI Codex', 'codex'), descriptor('claude-code', 'Claude Code', 'claude-sdk'), descriptor('opencode', 'OpenCode', 'opencode'), descriptor('openclaw', 'OpenClaw', 'openclaw'), descriptor('goose', 'Goose', 'acp'), descriptor('openhands', 'OpenHands', 'openhands'), descriptor('gemini-cli', 'Gemini CLI', 'acp')];
const previewModels = [
  ['preview-model', 'Claude Sonnet'], ['preview-model-2', 'GPT · Exemple'], ['codex-auto-review', 'Codex Auto Review'],
  ['glm-4.5', 'GLM 4.5'], ['glm-4.6', 'GLM 4.6'], ['qwen3-coder', 'Qwen3 Coder'], ['deepseek-v3.2', 'DeepSeek V3.2'],
  ['gpt-5.2-codex', 'GPT-5.2 Codex'], ['gpt-5.3-codex', 'GPT-5.3 Codex'], ['gpt-6-sol', 'GPT-6 Sol'],
  ['gpt-6.1-sol', 'GPT-6.1 Sol'], ['gpt-6-astra', 'GPT-6 Astra'], ['gpt-6-luna', 'GPT-6 Luna'],
  ['kimi-k2-thinking', 'Kimi K2 Thinking'], ['mistral-large', 'Mistral Large'], ['llama-4-scout', 'Llama 4 Scout'],
].map(([id, name]) => ({ id, name, local: false }));
const session = (id, state) => ({ id, harnessId: 'pi', targetId: 'local', workspace: '/workspace/exemple', title: 'Préparer le lancement', model: 'Claude Sonnet', authMode: 'native', state, queuePaused: false, revision: 1, activeTurnId: `${id}-turn`, archived: false, pinned: false, createdAt: now, updatedAt: now, capabilities });
const sessions = { 'preview-working': session('preview-working', 'running'), 'preview-question': session('preview-question', 'waiting_user') };
const queues = Object.fromEntries(Object.keys(sessions).map(id => [id, []]));
const interactions = { 'preview-working': [], 'preview-question': [{ id: 'preview-choice', sessionId: 'preview-question', kind: 'question', title: 'Quel ton souhaitez-vous pour cette présentation ?', detail: { questions: [{ id: 'tone', question: 'Choisissez la direction qui vous convient.', options: [{ label: 'Clair et accessible', description: 'Une présentation directe, compréhensible par tous.' }, { label: 'Précis et technique', description: 'Plus de détails pour un public spécialisé.' }] }] }, status: 'pending', createdAt: now, expiresAt: now + 3_600_000 }] };
for (const [index, text] of ['Ajoute une synthèse des prochaines étapes.', 'Prépare aussi une version en anglais.'].entries()) queues['preview-working'].push({ id: `queued-${index}`, sessionId: 'preview-working', command: { type: 'prompt', parts: [{ type: 'text', text }] }, state: 'queued', createdAt: now, ordinal: index });
const event = (seq, type, payload, itemId, turnId = 'preview-working-turn') => ({ seq, sessionId: 'preview-working', type, payload, itemId, turnId, createdAt: now });
const activity = [event(1, 'tool', { type: 'tool_execution_start', toolName: 'Lire les notes du projet' }, 'read'), event(2, 'tool', { type: 'tool_execution_end', result: { content: [{ type: 'text', text: 'Les objectifs et contraintes du projet ont été retrouvés.' }] } }, 'read'), event(3, 'plan', { entries: [{ content: 'Rassembler les informations', status: 'completed' }, { content: 'Structurer la présentation', status: 'in_progress' }, { content: 'Préparer la synthèse', status: 'pending' }] }), event(4, 'tool', { type: 'tool_execution_start', toolName: 'Structurer les idées' }, 'write')];
const message = (role, content) => ({ id: randomUUID(), role, content, interrupted: false });
const conversation = (title, messages = [], extra = {}) => ({ id: randomUUID(), title, model: 'preview-model', messages, updatedAt: new Date(now).toISOString(), draft: '', ...extra });
const seed = [conversation('Nouvelle conversation'), conversation('Une présentation qui va à l’essentiel', [message('user', 'Aide-moi à préparer une présentation claire pour le lancement de notre projet.'), message('assistant', 'Voici une structure simple pour présenter le projet en cinq minutes.\n\n## Une idée, trois temps\n\n**1. Le point de départ**\nPrésentez le besoin et ce qui vous a donné envie d’y répondre. Un exemple concret aidera votre public à se projeter.\n\n**2. Ce que nous proposons**\nMontrez la solution avec une démonstration courte. Gardez les détails techniques pour les questions.\n\n**3. La prochaine étape**\nTerminez par une action précise : tester le prototype, partager un retour ou rejoindre le projet.\n\nJe peux maintenant vous aider à rédiger chaque partie.')], { pinned: true }), conversation('Préparer le lancement', [message('user', 'Transforme les notes du projet en présentation.'), message('assistant', 'J’ai rassemblé les objectifs et les contraintes. Je prépare maintenant le fil conducteur de la présentation.')], { harnessID: 'pi', authMode: 'native', runtimeSessionID: 'preview-working', runtimeSession: sessions['preview-working'], runtimeCursor: 4, runtimeEvents: activity }), conversation('Choisir la direction', [message('user', 'Peux-tu adapter la présentation à notre public ?')], { harnessID: 'pi', authMode: 'native', runtimeSessionID: 'preview-question', runtimeSession: sessions['preview-question'] }), conversation('Notes de recherche', [message('user', 'Résume ces notes.')]), conversation('Explorer les usages possibles', [message('user', 'Explorons les possibilités.')], { updatedAt: new Date(now - 2 * 86_400_000).toISOString() }), conversation('Ancien projet', [message('user', 'Prépare un plan.')], { archived: true })];
const streams = new Map(); let seq = 100;
const publish = (id, type, payload) => { const value = { seq: ++seq, sessionId: id, type, payload, turnId: `${id}-turn`, createdAt: Date.now() }; for (const stream of streams.get(id) ?? []) stream.write(`data: ${JSON.stringify(value)}\n\n`); };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1'); const route = url.pathname;
  const send = (value) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (route === '/preview/seed') return send(seed);
  if (route === '/v1/models') return send({ data: previewModels });
  if (route === '/v1/chat/completions') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Voici une réponse de prévisualisation ' }, finish_reason: null }] })}\n\n`);
    setTimeout(() => {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'affichée progressivement.' }, finish_reason: 'stop' }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    }, 300);
    return;
  }
  if (route === '/admin/host-conversation-harnesses') return send({ harnesses: [] });
  if (route.endsWith('/targets')) return send({ targets: [{ id: 'local', name: 'Ce Mac', kind: 'local' }, { id: 'preview-remote', name: 'Serveur de travail', kind: 'ssh' }] });
  if (route.endsWith('/catalog')) return send({ harnesses: catalog });
  if (route.includes('/native-sessions')) return send({ sessions: [] });
  if (route.endsWith('/sessions')) return send({ sessions: Object.values(sessions) });
  if (route === '/models') return send({ models: previewModels.map(model => ({ id: model.id, name: model.name, provider: 'preview' })), currentModelId: 'preview-model', provider: 'preview' });
  const match = route.match(/\/sessions\/([^/]+)(?:\/(events|commands))?$/u);
  if (match) {
    const [, id, action] = match;
    if (!sessions[id]) { response.writeHead(404); return response.end('{}'); }
    if (action === 'events') { response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); response.write(': fixture connected\n\n'); const clients = streams.get(id) ?? new Set(); clients.add(response); streams.set(id, clients); request.on('close', () => clients.delete(response)); return; }
    if (!action) return send({ session: sessions[id], queue: queues[id], interactions: interactions[id] });
    let text = ''; for await (const chunk of request) text += chunk;
    const command = JSON.parse(text);
    if (command.type === 'respond') { interactions[id] = []; sessions[id].state = 'idle'; publish(id, 'interaction.updated', { id: command.value.interactionId }); }
    if (command.type === 'interrupt') { sessions[id].state = 'interrupted'; sessions[id].queuePaused = true; }
    if (['pause_queue', 'resume_queue'].includes(command.type)) sessions[id].queuePaused = command.type === 'pause_queue';
    if (command.type === 'queue_remove') queues[id] = queues[id].filter(row => row.id !== command.value.commandId);
    if (command.type === 'queue_edit') queues[id] = queues[id].map(row => row.id === command.value.commandId ? { ...row, command: { ...row.command, parts: command.value.parts } } : row);
    if (command.type === 'queue_reorder') queues[id] = command.value.ids.map((key, ordinal) => ({ ...queues[id].find(row => row.id === key), ordinal }));
    publish(id, 'session.updated', sessions[id]);
    return send({ receipt: { id: command.id, sessionId: id, command, state: 'completed', createdAt: Date.now(), ordinal: 0, result: command.type === 'inspect' ? { commands: [{ name: 'compact', description: 'Compacter le contexte' }] } : {} } });
  }
  response.writeHead(404, { 'content-type': 'application/json' }); response.end('{"error":"Unavailable in isolated UI preview"}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let child;
try {
  const contents = path.join(root, 'MultiVibe UI Preview.app/Contents');
  const resources = path.join(contents, 'Resources'); await mkdir(resources, { recursive: true }); await mkdir(path.join(contents, 'MacOS'));
  const generated = path.join(root, 'MultiVibeMenuBar.swift');
  await writeFile(generated, (await readFile(path.join(repository, 'packaging/macos/MultiVibeMenuBar.swift'), 'utf8')).replace('@main\nfinal class MultiVibeMenuBarApp', 'class MultiVibeMenuBarApp').replace('    static func main()', '    @MainActor static func main()'));
  await writeFile(path.join(root, 'host-credentials.json'), JSON.stringify({ schema_version: 1, admin_token: 'isolated-preview-admin', proxy_api_key: 'isolated-preview-model' }));
  await writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>app.multivibe.ui-preview</string><key>CFBundleName</key><string>MultiVibe UI Preview</string><key>CFBundleExecutable</key><string>MultiVibeUIPreview</string><key>NSPrincipalClass</key><string>MVCEFApplication</string><key>NSHighResolutionCapable</key><true/></dict></plist>`);
  await cp(path.join(repository, 'packaging/macos/resources/harnesses'), path.join(resources, 'harnesses'), { recursive: true });
  const cef = await buildAndInstallCef({ architecture: 'arm64', contents, temporary: root, repository });
  const sources = (await readdir(path.join(repository, 'packaging/macos'))).filter(name => name.endsWith('.swift') && name !== 'MultiVibeMenuBar.swift').map(name => path.join(repository, 'packaging/macos', name));
  const binary = path.join(contents, 'MacOS/MultiVibeUIPreview');
  console.log('Compiling production SwiftUI views for isolated UI preview…');
  await new Promise((resolve, reject) => {
    const compiler = spawn('xcrun', ['swiftc', '-parse-as-library', '-module-name', 'MultiVibeUIPreview', '-target', 'arm64-apple-macos13.0', ...sources, generated, path.join(repository, 'packaging/macos/validation/NativeChatPreview.swift'), cef.bridge, cef.wrapper, '-lc++', '-o', binary], { env: { ...process.env, DEVELOPER_DIR: resolveMacOSDeveloperDirectory() }, stdio: 'inherit' });
    compiler.on('exit', code => code === 0 ? resolve() : reject(new Error(`Preview compiler exited ${code}`)));
  });
  child = spawn(binary, [], { env: { ...process.env, MULTIVIBE_HOST_DATA_DIR: root, MULTIVIBE_UI_PREVIEW_URL: `http://127.0.0.1:${server.address().port}` }, stdio: 'inherit' });
  console.log(`UI preview running at ${path.dirname(contents)} (Cmd+1…9 selects scenarios)`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill());
  await new Promise(resolve => child.on('exit', resolve));
} finally {
  server.closeAllConnections(); server.close();
  await rm(root, { recursive: true, force: true });
}
