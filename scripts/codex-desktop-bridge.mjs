#!/usr/bin/env node
// Keep Codex's ChatGPT identity while authenticating inference to MultiVibe.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile, chmod, access, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const blockedRequestHeaders = new Set([
  'authorization', 'x-api-key', 'api-key', 'cookie', 'proxy-authorization',
  'chatgpt-account-id', 'openai-organization', 'openai-project', 'host',
  'x-multivibe-internal-token', 'x-multivibe-internal-application',
]);
const allowedPath = /^\/v1\/(?:responses(?:\/compact)?|models(?:\/[^/]+)?)$/;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function managedProxyKey(config) {
  let table = '';
  for (const line of config.split(/\r?\n/)) {
    const heading = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (heading) table = heading[1].trim();
    if (table !== 'model_providers.multivibe') continue;
    const assignment = /^\s*experimental_bearer_token\s*=\s*("(?:\\.|[^"\\])*")\s*(?:#.*)?$/.exec(line);
    if (assignment) {
      const key = JSON.parse(assignment[1]);
      if (!key || /[\r\n]/.test(key)) throw new Error('Invalid managed MultiVibe credential');
      return key;
    }
  }
  throw new Error('Managed MultiVibe credential is missing from config.toml');
}

export function desktopConfig(config, port) {
  // These root settings must be before the first TOML table. Preserve provider,
  // project, profile, model catalogue and user settings, including the proxy key.
  let table = false;
  const rest = config.split(/\r?\n/).filter(line => {
    if (/^\s*\[/.test(line)) table = true;
    return table || !/^\s*(?:model_provider|openai_base_url|cli_auth_credentials_store)\s*=/.test(line);
  }).join('\n').replace(/^# MultiVibe Desktop voice bridge\n/m, '').trim();
  return `# MultiVibe Desktop voice bridge\nmodel_provider = "openai"\nopenai_base_url = "http://127.0.0.1:${port}/v1"\ncli_auth_credentials_store = "file"\n\n${rest}\n`;
}

function reject(response, status, message) {
  const body = JSON.stringify({ error: { message, type: 'authentication_error' } });
  if (response instanceof http.ServerResponse) {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(body);
  } else {
    response.end(`HTTP/1.1 ${status} Rejected\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }
}

function upstreamHeaders(headers, key, upgrade) {
  const output = {};
  const connectionHeaders = new Set(String(headers.connection ?? '').toLowerCase().split(',').map(x => x.trim()));
  for (const [name, value] of Object.entries(headers)) {
    if (blockedRequestHeaders.has(name) || connectionHeaders.has(name) ||
        ['connection', 'upgrade', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer'].includes(name)) continue;
    output[name] = value;
  }
  output.authorization = `Bearer ${key}`;
  output['x-multivibe-client'] = 'openai-codex';
  if (upgrade) { output.connection = 'Upgrade'; output.upgrade = 'websocket'; }
  return output;
}

export function createDesktopBridge({ codexHome, upstream = 'http://127.0.0.1:1455/v1', now = Date.now }) {
  const target = new URL(upstream);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password ||
      target.search || target.hash || target.pathname.replace(/\/$/, '') !== '/v1') {
    throw new Error('Upstream must be an explicit loopback HTTP /v1 endpoint');
  }
  async function authorize(request) {
    if (request.socket.remoteAddress !== '127.0.0.1') return;
    const requested = new URL(request.url, 'http://127.0.0.1');
    if (!allowedPath.test(requested.pathname) || !['GET', 'POST'].includes(request.method)) return;
    // Do not offer a browser-accessible proxy or accept credentials in URLs.
    if (request.headers.origin || request.url.startsWith('http') || requested.searchParams.has('api_key') ||
        requested.searchParams.has('client_secret')) return;
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    const [auth, config] = await Promise.all([
      readFile(path.join(codexHome, 'auth.json'), 'utf8').then(JSON.parse),
      readFile(path.join(codexHome, 'config.toml'), 'utf8'),
    ]);
    const stored = auth.tokens?.access_token;
    if (auth.auth_mode !== 'chatgpt' || !same(token, stored)) return;
    const claims = JSON.parse(Buffer.from(stored.split('.')[1], 'base64url').toString('utf8'));
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now()) return;
    const account = auth.tokens?.account_id;
    if (!account || (request.headers['chatgpt-account-id'] && !same(request.headers['chatgpt-account-id'], account))) return;
    return { key: managedProxyKey(config), pathname: requested.pathname + requested.search };
  }
  async function forward(request, destination, head) {
    let auth;
    try { auth = await authorize(request); } catch {
      reject(destination, 503, 'Local Codex credentials are unavailable; sign in to ChatGPT and check the bridge configuration'); return;
    }
    if (!auth) { reject(destination, 401, 'A current local ChatGPT sign-in is required'); return; }
    if (destination.destroyed) return;
    const upgrade = head !== undefined;
    const outgoing = http.request(new URL(auth.pathname, target), {
      method: request.method, headers: upstreamHeaders(request.headers, auth.key, upgrade),
    });
    let upstreamSocket;
    outgoing.setTimeout(300_000, () => outgoing.destroy(new Error('Upstream idle timeout')));
    outgoing.on('error', () => {
      if (destination instanceof http.ServerResponse && destination.headersSent) destination.destroy();
      else if (!destination.destroyed) reject(destination, 502, 'MultiVibe is unavailable');
    });
    outgoing.on('response', response => {
      // An invalid MultiVibe application key must not log the ChatGPT account out.
      if (response.statusCode === 401 || response.statusCode === 403) {
        response.resume(); reject(destination, 502, 'MultiVibe rejected its managed application credential'); return;
      }
      if (upgrade) {
        response.resume(); reject(destination, 502, 'MultiVibe did not accept the Responses WebSocket'); return;
      }
      const headers = { ...response.headers };
      delete headers['set-cookie']; delete headers['www-authenticate'];
      if (destination instanceof http.ServerResponse) destination.writeHead(response.statusCode, headers);
      else destination.write(`HTTP/1.1 ${response.statusCode} Upstream\r\n${Object.entries(headers).map(([k,v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      response.pipe(destination);
      response.on('error', () => destination.destroy());
    });
    outgoing.on('upgrade', (response, socket, upstreamHead) => {
      upstreamSocket = socket;
      const headers = Object.entries(response.headers).filter(([k]) => k !== 'set-cookie');
      destination.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.map(([k,v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (upstreamHead.length) destination.write(upstreamHead);
      if (head.length) socket.write(head);
      destination.pipe(socket).pipe(destination);
      socket.on('error', () => destination.destroy());
      socket.on('close', () => destination.destroy());
    });
    if (upgrade) {
      destination.on('close', () => { outgoing.destroy(); upstreamSocket?.destroy(); });
      destination.on('error', () => { outgoing.destroy(); upstreamSocket?.destroy(); });
      outgoing.end();
    } else {
      destination.on('close', () => { if (!destination.writableFinished) outgoing.destroy(); });
      request.on('aborted', () => outgoing.destroy());
      request.pipe(outgoing);
    }
  }
  const server = http.createServer((request, response) => { void forward(request, response); });
  server.on('upgrade', (request, socket, head) => { void forward(request, socket, head); });
  return server;
}

const escapeXml = text => text.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
async function install(codexHome, port) {
  if (process.platform !== 'darwin') throw new Error('Automatic startup installation is currently macOS-only');
  const configPath = path.join(codexHome, 'config.toml');
  const config = await readFile(configPath, 'utf8');
  managedProxyKey(config); // Validate before changing anything.
  const backup = `${configPath}.before-MULTIVIBE-218-${Date.now()}`;
  const bridge = path.join(codexHome, 'multivibe-desktop-bridge.mjs');
  const plistPath = path.join(os.homedir(), 'Library/LaunchAgents/com.pleiades.multivibe-codex-bridge.plist');
  const settings = path.join(codexHome, 'multivibe-desktop-bridge.json');
  const args = [process.execPath, bridge, '--codex-home', codexHome, '--port', String(port)];
  const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.pleiades.multivibe-codex-bridge</string><key>ProgramArguments</key><array>${args.map(a => `<string>${escapeXml(a)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardErrorPath</key><string>${escapeXml(path.join(codexHome, 'multivibe-desktop-bridge.log'))}</string></dict></plist>`;
  // Refuse to overwrite another installation or an occupied listener.
  const probe = createDesktopBridge({ codexHome });
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
  for (const artifact of [plistPath, bridge, settings]) {
    try { await access(artifact); throw new Error('Bridge installation already exists; inspect it before reinstalling'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await copyFile(configPath, backup); await chmod(backup, 0o600);
  await copyFile(fileURLToPath(import.meta.url), bridge); await chmod(bridge, 0o700);
  await writeFile(settings, JSON.stringify({ backup, port, upstream: 'http://127.0.0.1:1455/v1' }) + '\n', { mode: 0o600 });
  await mkdir(path.dirname(plistPath), { recursive: true });
  await writeFile(plistPath, plist, { mode: 0o600 });
  try {
    execFileSync('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plistPath], { stdio: 'pipe' });
    await writeFile(configPath, desktopConfig(config, port), { mode: 0o600 });
  } catch (error) {
    try { execFileSync('/bin/launchctl', ['bootout', `gui/${process.getuid()}`, plistPath], { stdio: 'pipe' }); } catch {}
    await writeFile(configPath, config, { mode: 0o600 });
    await Promise.all([plistPath, bridge, settings].map(file => unlink(file).catch(() => {})));
    throw new Error('Bridge installation failed; the original Codex configuration has been restored');
  }
  console.log(`Bridge installed on 127.0.0.1:${port}. Configuration backup: ${backup}`);
  console.log('ChatGPT Voice connects directly to OpenAI. Inference uses MultiVibe. A valid ChatGPT sign-in is required.');
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
  const codexHome = path.resolve(option('--codex-home', process.env.CODEX_HOME || path.join(os.homedir(), '.codex')));
  const port = Number(option('--port', '1459'));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid bridge port');
  if (args.includes('--install')) { await install(codexHome, port); return; }
  const server = createDesktopBridge({ codexHome });
  server.on('error', () => { console.error('Codex desktop bridge cannot bind its loopback port'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1');
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Codex desktop bridge failed; inspect configuration and the local listener'); process.exitCode = 1; });
}
