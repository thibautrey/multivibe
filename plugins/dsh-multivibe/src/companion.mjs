import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CompanionError, buildProvider, discoverGateway, normalizeGatewayURL, requestJSON, validateProviderId } from './gateway.mjs';

const emptyState = () => ({ revision: 0, connection: null, pending: null });
const conflict = () => new CompanionError('CONFLICT', 'The configuration changed. Refresh the status before trying again.', 409);

/** All mutations are operator-only HTTP actions, never model-facing tools. */
export function createCompanion(ctx, { stateKey = 'dsh-multivibe/connection', fetchImpl = globalThis.fetch, clock = Date.now, random = randomBytes } = {}) {
  let queue = Promise.resolve();
  const serialize = action => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  };
  async function read() {
    const record = await ctx.credentials.readRecord(stateKey);
    if (!record) return emptyState();
    const state = record.payload;
    if (record.kind !== 'grant' || !state || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Object.hasOwn(state, 'connection') || !Object.hasOwn(state, 'pending')) {
      throw new CompanionError('INVALID_STATE', 'The saved companion state could not be read safely.', 503);
    }
    return state;
  }
  async function update(change) {
    await ctx.credentials.modifyRecord(stateKey, record => {
      const state = record?.kind === 'grant' ? record.payload : emptyState();
      if (!state || !Number.isSafeInteger(state.revision)) throw new CompanionError('INVALID_STATE', 'The saved companion state could not be read safely.', 503);
      return { kind: 'grant', payload: change(state) };
    });
  }
  function forms() { return ctx.settings.describe(); }
  function formFor(ns) {
    const form = forms().find(item => item.ns === ns);
    if (!form) throw new CompanionError('PROVIDER_UNAVAILABLE', 'The model provider configuration is no longer available.', 503);
    return form;
  }
  async function namespaces() {
    const directory = await ctx.llm.listConfigurableProviders();
    const available = forms();
    const result = new Map();
    for (const item of directory) {
      // Directory metadata discovers the real namespace; do not hardcode an entry ID.
      if (!Array.isArray(item.settingsPath) || item.settingsPath[0] !== 'providers' || !available.some(form => form.ns === item.settingsNs)) continue;
      const form = available.find(form => form.ns === item.settingsNs);
      const schema = form.schema;
      const resolve = node => (typeof node === 'number' || typeof node === 'string') ? schema?.refs?.[node] : node;
      const root = schema?.refs ? resolve(schema.uid) : schema;
      const dictionary = resolve(root?.dict?.providers);
      const profile = resolve(dictionary?.inner ?? dictionary?.value);
      // Different adapters may expose provider dictionaries. Require the pi-ai profile contract.
      if (!profile?.dict || !['apiKeyEnv', 'baseURL', 'models'].every(field => Object.hasOwn(profile.dict, field))) continue;
      result.set(item.settingsNs, { settingsNs: item.settingsNs, displayName: item.settingsNs });
    }
    return [...result.values()];
  }
  function currentProvider(connection) {
    // Compare the authored override, not the live value expanded with SDK defaults.
    return formFor(connection.settingsNs).user?.providers?.[connection.providerId];
  }
  async function configuredProviders(connection) {
    const allowed = new Set((await namespaces()).map(item => item.settingsNs));
    const result = [];
    for (const form of forms()) {
      if (!allowed.has(form.ns)) continue;
      for (const [providerId, config] of Object.entries(form.value?.providers ?? {})) {
        if (!config || typeof config !== 'object' || typeof config.baseURL !== 'string') continue;
        let baseURL;
        try { baseURL = normalizeGatewayURL(config.baseURL).baseURL; } catch { continue; }
        const endpoint = new URL(baseURL);
        const known = baseURL === connection?.baseURL || /multivibe/i.test(`${providerId} ${config.displayName ?? ''}`)
          || (['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) && endpoint.port === '1455');
        if (!known || connection?.settingsNs === form.ns && connection?.providerId === providerId) continue;
        const models = (Array.isArray(config.models) ? config.models : []).slice(0, 256).filter(model => model && typeof model.id === 'string').map(model => ({
          id: model.id.slice(0, 512), name: typeof model.name === 'string' ? model.name.slice(0, 512) : model.id.slice(0, 512),
          ...(Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
          ...(Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {}),
        }));
        const credentialConfigured = typeof config.apiKeyEnv === 'string' && (await ctx.credentials.describe(config.apiKeyEnv)).configured === true;
        result.push({ providerId, settingsNs: form.ns, displayName: typeof config.displayName === 'string' ? config.displayName.slice(0, 160) : providerId,
          baseURL, protocol: ['openai-completions', 'openai-responses'].includes(config.api) ? config.api : null, credentialConfigured, models });
      }
    }
    return result;
  }
  async function status() {
    const state = await read();
    let matches = false;
    if (state.connection) {
      try { matches = isDeepStrictEqual(currentProvider(state.connection), state.connection.providerConfig); } catch { /* Detached adapter is not a connected provider. */ }
    }
    const configured = state.connection ? (await ctx.credentials.describe(state.connection.credentialRef)).configured : false;
    return {
      revision: state.revision, connected: Boolean(state.connection && matches && configured && !state.pending), pending: Boolean(state.pending),
      connection: state.connection ? { providerId: state.connection.providerId, baseURL: state.connection.baseURL,
        protocol: state.connection.providerConfig.api, modelCount: state.connection.providerConfig.models.length, connectedAt: state.connection.connectedAt,
        modified: !matches, credentialConfigured: configured } : null,
      providers: await namespaces(),
      existingProviders: await configuredProviders(state.connection),
      retainedCredentialRefs: state.retainedCredentialRefs ?? [],
    };
  }
  function checkRevision(input, state) {
    if (!input || !Number.isSafeInteger(input.revision) || input.revision !== state.revision) throw conflict();
  }
  async function discover(input, signal) {
    return discoverGateway({ baseURL: input?.baseURL, apiKey: input?.apiKey, fetchImpl, signal });
  }
  async function active() {
    const state = await read();
    if (!state.connection || state.pending) throw new CompanionError('NOT_CONNECTED', 'Connect MultiVibe in Settings > Plugins > MultiVibe first.');
    if (!isDeepStrictEqual(currentProvider(state.connection), state.connection.providerConfig)) throw new CompanionError('PROVIDER_MODIFIED', 'The managed provider was edited outside the companion. Restore it or disconnect manually.', 409);
    const secret = await ctx.credentials.resolve(state.connection.credentialRef);
    if (!secret?.value) throw new CompanionError('MISSING_CREDENTIAL', 'The managed proxy API key is not configured.', 401);
    return { ...state.connection, apiKey: secret.value };
  }
  async function catalog(signal) {
    const connection = await active();
    return discoverGateway({ baseURL: connection.baseURL, apiKey: connection.apiKey, fetchImpl, signal });
  }
  async function health(signal) {
    const connection = await active();
    const { origin } = normalizeGatewayURL(connection.baseURL);
    const result = await requestJSON(`${origin}/health`, { fetchImpl, signal });
    return { ok: result?.ok === true };
  }
  async function acquire(input, pending, requiredConnection) {
    await update(state => {
      checkRevision(input, state);
      if (state.pending) throw new CompanionError('RECOVERY_REQUIRED', 'An incomplete operation needs recovery before another change.', 409);
      if (requiredConnection === false && state.connection) throw new CompanionError('ALREADY_CONNECTED', 'Disconnect the existing managed provider before connecting another gateway.', 409);
      if (requiredConnection === true && !state.connection) throw new CompanionError('NOT_CONNECTED', 'No managed provider is connected.');
      return { ...state, revision: state.revision + 1, pending };
    });
  }
  async function finish(pending, connection) {
    await update(state => {
      if (state.pending?.id !== pending.id) throw conflict();
      const retainedCredentialRefs = new Set(state.retainedCredentialRefs ?? []);
      if (pending.kind === 'disconnect' && pending.removeCredential !== true) retainedCredentialRefs.add(pending.connection.credentialRef);
      return { revision: state.revision + 1, connection, pending: null, retainedCredentialRefs: [...retainedCredentialRefs] };
    });
  }
  async function removeOwnedProvider(connection) {
    const form = formFor(connection.settingsNs);
    const value = form.user?.providers?.[connection.providerId];
    if (value === undefined && form.value?.providers?.[connection.providerId] === undefined) return;
    if (!isDeepStrictEqual(value, connection.providerConfig)) throw new CompanionError('PROVIDER_MODIFIED', 'The provider changed outside the companion. No configuration or credential was removed.', 409);
    // Unset restores inheritance, so never acquire a provider ID already present in base/value.
    if (form.base?.providers?.[connection.providerId] !== undefined) throw new CompanionError('PROVIDER_MODIFIED', 'An inherited provider now uses this ID. Remove the managed provider manually.', 409);
    await ctx.settings.mutate(connection.settingsNs, [{ op: 'unset', path: ['providers', connection.providerId] }], form.revision);
    if (formFor(connection.settingsNs).value?.providers?.[connection.providerId] !== undefined) throw new CompanionError('RECOVERY_REQUIRED', 'The provider removal did not complete.', 409);
  }
  async function removeUnusedCredential(ref) {
    const marker = JSON.stringify(ref);
    if (forms().some(form => JSON.stringify(form.value).includes(marker))) throw new CompanionError('CREDENTIAL_IN_USE', 'Another configuration references the managed credential. It was not removed.', 409);
    await ctx.credentials.unset(ref);
  }
  async function compensate(pending) {
    await removeOwnedProvider(pending.connection);
    // Fresh failed connects compensate their own new secret. Established disconnects
    // preserve it unless explicitly requested: settings views cannot prove global non-use.
    if (pending.kind === 'connect' || pending.removeCredential === true) await removeUnusedCredential(pending.connection.credentialRef);
    await finish(pending, null);
  }
  async function connect(input, signal) {
    return serialize(async () => {
      const state = await read();
      checkRevision(input, state);
      if (state.connection) throw new CompanionError('ALREADY_CONNECTED', 'Disconnect the existing managed provider before connecting another gateway.', 409);
      if (state.pending) throw new CompanionError('RECOVERY_REQUIRED', 'Recover the incomplete operation first.', 409);
      const providerId = validateProviderId(input.providerId);
      if (!(await namespaces()).some(item => item.settingsNs === input.settingsNs)) throw new CompanionError('PROVIDER_UNAVAILABLE', 'Select an available configurable model adapter.');
      const discovered = await discover(input, signal);
      const form = formFor(input.settingsNs);
      if (form.value?.providers?.[providerId] !== undefined || form.base?.providers?.[providerId] !== undefined || (await ctx.llm.listProviders()).some(item => item.id === providerId)) {
        throw new CompanionError('PROVIDER_EXISTS', 'That provider ID already exists. Choose a new ID; existing providers are never overwritten.', 409);
      }
      const credentialRef = `MULTIVIBE_DSH_${random(16).toString('hex').toUpperCase()}`;
      const description = await ctx.credentials.describe(credentialRef);
      if (description.configured || !description.writable) throw new CompanionError('CREDENTIAL_READ_ONLY', 'A new writable credential reference could not be allocated.', 403);
      const providerConfig = buildProvider({ ...input, models: discovered.models, baseURL: discovered.baseURL, credentialRef });
      const connection = { providerId, settingsNs: input.settingsNs, credentialRef, baseURL: discovered.baseURL, providerConfig, connectedAt: clock() };
      const pending = { id: random(16).toString('hex'), kind: 'connect', connection };
      signal?.throwIfAborted();
      await acquire(input, pending, false);
      try {
        await ctx.credentials.set(credentialRef, input.apiKey.trim());
        await ctx.settings.mutate(input.settingsNs, [{ op: 'set', path: ['providers', providerId], value: providerConfig }], form.revision);
        if (!isDeepStrictEqual(currentProvider(connection), providerConfig)) throw new CompanionError('PROVIDER_MODIFIED', 'The provider did not accept the exact managed configuration.', 409);
        await finish(pending, connection);
      } catch (error) {
        const latest = await read();
        if (!latest.pending && latest.connection?.credentialRef === credentialRef) return status();
        try { await compensate(pending); } catch {
          throw new CompanionError('RECOVERY_REQUIRED', 'The operation could not be safely restored. Use Recover in the companion; no unrelated provider is overwritten.', 409);
        }
        if (error instanceof CompanionError) throw error;
        if (error?.name === 'SettingsConflictError' || error?.code === 'SETTINGS_CONFLICT') throw conflict();
        throw new CompanionError('CONNECT_FAILED', 'DSH rejected the provider configuration. The managed changes were restored.', 503);
      }
      return status();
    });
  }
  async function disconnect(input) {
    return serialize(async () => {
      const state = await read();
      checkRevision(input, state);
      if (!state.connection) throw new CompanionError('NOT_CONNECTED', 'No managed provider is connected.');
      // Check ownership before storing any journal or changing the credential.
      const form = formFor(state.connection.settingsNs);
      const absent = form.user?.providers?.[state.connection.providerId] === undefined && form.value?.providers?.[state.connection.providerId] === undefined;
      if (!absent && !isDeepStrictEqual(currentProvider(state.connection), state.connection.providerConfig)) throw new CompanionError('PROVIDER_MODIFIED', 'The provider was edited outside the companion. No configuration or credential was removed.', 409);
      const pending = { id: random(16).toString('hex'), kind: 'disconnect', connection: state.connection, removeCredential: input.removeCredential === true };
      await acquire(input, pending, true);
      try { await compensate(pending); } catch {
        throw new CompanionError('RECOVERY_REQUIRED', 'Disconnect is incomplete. Use Recover to finish removing only the managed provider and unused credential.', 409);
      }
      return status();
    });
  }
  async function recover(input) {
    return serialize(async () => {
      const state = await read();
      checkRevision(input, state);
      if (!state.pending) return status();
      await compensate(state.pending);
      return status();
    });
  }
  return { status, discover, catalog, health, connect, disconnect, recover };
}
