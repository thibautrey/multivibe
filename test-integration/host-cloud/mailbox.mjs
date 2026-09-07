#!/usr/bin/env node
// Explicit live test mailbox; never used by the default automated test suite.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
const root = path.resolve(process.env.MULTIVIBE_LAB_DIR ?? path.join(os.homedir(), '.local/share/multivibe-host-cloud-lab'));
const secretFile = path.join(root, 'test-identity.json');
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
async function api(route, body, token) {
  const response = await fetch(`https://api.mail.tm${route}`, { method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Test mailbox API ${route} returned ${response.status}`);
  return response.json();
}
if (process.argv[2] === 'create') {
  if (fs.existsSync(secretFile)) throw new Error('Test identity already exists; reuse it instead of creating another account');
  const domains = await api('/domains');
  const domain = domains['hydra:member'].find(d => d.isActive && !d.isPrivate)?.domain;
  if (!domain) throw new Error('No available test-mail domain');
  const address = `multivibe-host-${randomBytes(8).toString('hex')}@${domain}`;
  const password = randomBytes(24).toString('base64url');
  await api('/accounts', { address, password });
  const { token } = await api('/token', { address, password });
  fs.writeFileSync(secretFile, JSON.stringify({ address, mailboxPassword: password,
    cloudPassword: randomBytes(24).toString('base64url'), mailboxToken: token }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ address, created: true }));
} else if (process.argv[2] === 'check') {
  const identity = JSON.parse(fs.readFileSync(secretFile));
  const messages = await api('/messages', undefined, identity.mailboxToken);
  const entries = messages['hydra:member'];
  console.log(JSON.stringify({ count: entries.length, subjects: entries.map(m => m.subject) }));
  for (const message of entries) {
    const detail = await api(`/messages/${encodeURIComponent(message.id)}`, undefined, identity.mailboxToken);
    const content = [detail.text ?? '', ...(detail.html ?? [])].join('\n');
    const links = [...content.matchAll(/https:\/\/auth\.multivibe\.cloud\/[^\s<>"']+/g)].map(m => m[0].replaceAll('&amp;', '&'));
    if (links.length) {
      fs.writeFileSync(path.join(root, 'verification-links.json'), JSON.stringify({ links }, null, 2), { mode: 0o600 });
      console.log('Verification links saved privately; not printed.');
      break;
    }
  }
} else throw new Error('Usage: mailbox.mjs create|check');
