#!/usr/bin/env node
// Reuse an existing Cloud project key. Never creates a Cloud identity, grant or key.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const cloudOrigin = 'https://api.multivibe.cloud';
export class LabError extends Error {}
const accountId = 'lab-cloud-existing-key';

export async function jsonRequest(fetchImpl, url, token, { method = 'GET', body, idempotencyKey } = {}) {
  let response;
  try {
    response = await fetchImpl(url, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
  } catch { throw new LabError('Request failed; redirect/network/timeout details withheld'); }
  // Never echo a provider error body: it may contain a reflected credential.
  if (!response.ok) throw new LabError(`Request rejected (HTTP ${response.status})`);
  try { return await response.json(); } catch { throw new LabError('Response was not JSON'); }
}

export function modelIds(payload) {
  if (!Array.isArray(payload?.data)) throw new LabError('Invalid Cloud model catalog');
  return new Set(payload.data.map(entry => entry?.id).filter(id => typeof id === 'string' && id.length > 0));
}

export async function main(args, env = process.env, fetchImpl = fetch) {
  const action = args[0];
  if (!['configure', 'verify', 'infer'].includes(action)
    || args.slice(1).some(arg => arg !== '--restart') || (args.includes('--restart') && action !== 'verify')) {
    throw new LabError('Usage: existing-access.mjs configure|verify [--restart]|infer');
  }
  // Require an explicitly identified Cloud test key. Never use generic API_KEY or MULTIVIBE_API_KEY.
  const suppliedKey = env.MULTIVIBE_CLOUD_TEST_API_KEY?.trim();
  if (action === 'configure' && !suppliedKey) throw new LabError('MULTIVIBE_CLOUD_TEST_API_KEY is required; no lab state changed');
  const root = path.resolve(env.MULTIVIBE_LAB_DIR ?? path.join(os.homedir(), '.local/share/multivibe-host-cloud-lab'));
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  if (root === repo || root.startsWith(repo + '/')) throw new LabError('Keep lab state outside the repository');
  const port = Number(env.MULTIVIBE_LAB_PORT ?? 18455);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new LabError('Invalid lab port');
  const origin = `http://127.0.0.1:${port}`;
  const credentials = JSON.parse(fs.readFileSync(path.join(root, 'data/host-credentials.json')));
  const accountsFile = path.join(root, 'data/accounts.json');
  const accounts = () => JSON.parse(fs.readFileSync(accountsFile)).accounts;
  const admin = (route, options) => jsonRequest(fetchImpl, origin + route, credentials.admin_token, options);
  const report = { checkedAt: new Date().toISOString(), action, authentication: 'existing-project-api-key',
    oauthConnectionVerified: false, cloudCatalogVerified: false, coreCatalogVerified: false,
    persistenceAfterRestartVerified: false, realInferenceVerified: false };
  const save = () => {
    fs.writeFileSync(path.join(root, 'existing-access-verification.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(report, null, 2));
  };
  try {
    if (action === 'configure') {
      if (accounts().length) throw new LabError('Use an empty isolated lab; existing accounts will not be overwritten');
      const models = modelIds(await jsonRequest(fetchImpl, `${cloudOrigin}/v1/models`, suppliedKey));
      if (!models.size) throw new LabError('Cloud key has no discoverable models; no lab state changed');
      report.cloudCatalogVerified = true;
      await admin('/admin/accounts', { method: 'POST', body: { id: accountId, provider: 'openai-compatible',
        accessToken: suppliedKey, baseUrl: cloudOrigin, location: 'cloud', upstreamMode: 'responses',
        compatibilityMode: 'responses', enabled: false } });
      // This marker selects Cloud's payload contract. It does not create an OAuth session.
      await admin(`/admin/accounts/${accountId}`, { method: 'PATCH', body: { multivibeCloud: true, enabled: true } });
    }
    let account = accounts().find(a => a.id === accountId);
    if (!account?.enabled || account.baseUrl !== cloudOrigin || account.multivibeCloud !== true) {
      throw new LabError('No configured existing-key Cloud account in this lab');
    }
    if (accounts().some(a => a.enabled && a.id !== accountId)) throw new LabError('Other enabled accounts could invalidate routing evidence');
    const verifyCatalogs = async () => {
      const remote = modelIds(await jsonRequest(fetchImpl, `${cloudOrigin}/v1/models`, account.accessToken));
      report.cloudCatalogVerified = remote.size > 0;
      const local = modelIds(await jsonRequest(fetchImpl, `${origin}/v1/models`, credentials.proxy_api_key));
      report.coreCatalogVerified = [...remote].some(id => local.has(id));
      if (!report.cloudCatalogVerified || !report.coreCatalogVerified) throw new LabError('No shared authenticated Cloud/Core model');
      return new Set([...remote].filter(id => local.has(id)));
    };
    let models = await verifyCatalogs();
    if (args.includes('--restart')) {
      const before = account;
      const lab = fileURLToPath(new URL('./lab.mjs', import.meta.url));
      try {
        for (const command of ['stop', 'start']) execFileSync(process.execPath, [lab, command], { env, stdio: 'pipe' });
      } catch { throw new LabError('Host restart failed; child output withheld'); }
      account = accounts().find(a => a.id === accountId);
      if (!account?.enabled || account.accessToken !== before.accessToken || account.baseUrl !== before.baseUrl
        || account.multivibeCloud !== true) throw new LabError('Cloud account changed across restart');
      models = await verifyCatalogs();
      report.persistenceAfterRestartVerified = true;
    }
    if (action === 'infer') {
      const model = env.MULTIVIBE_CLOUD_TEST_MODEL;
      if (!model || !models.has(model)) throw new LabError('Select a catalog model with MULTIVIBE_CLOUD_TEST_MODEL; no inference sent');
      // One short generation. No retries, purchases, credit grants or billing changes.
      const result = await jsonRequest(fetchImpl, `${origin}/v1/responses`, credentials.proxy_api_key, { method: 'POST', idempotencyKey: randomUUID(),
        body: { model, input: 'Reply with OK.', max_output_tokens: 16, stream: false } });
      report.realInferenceVerified = result.status === 'completed' && Array.isArray(result.output)
        && result.output.some(item => item.type === 'message' && item.content?.some(part => part.type === 'output_text' && part.text?.trim()));
      if (!report.realInferenceVerified) throw new LabError('No completed text inference result');
    }
    save();
  } catch (error) {
    report.failed = true;
    save();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    // Child process and I/O errors can carry logs or credentials: report only known safe errors.
    console.error(error instanceof LabError ? error.message : 'Existing-access verification failed; details withheld');
    process.exitCode = 1;
  });
}
