import { CompanionError, publicError } from './gateway.mjs';

const loopback = hostname => hostname === 'localhost' || hostname === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(hostname);
export function assertLocalMutation(request) {
  // The real Connection bridge uses http://dsh.internal for relative HTTP URLs.
  // Host has already passed its authority/authentication fence; never trust forwarded headers.
  const host = request.headers.get('host');
  let authority;
  try {
    if (!host) throw new Error('missing authority');
    authority = new URL(`http://${host}`);
    if (authority.username || authority.password || authority.pathname !== '/' || authority.search || authority.hash) throw new Error('invalid authority');
  } catch { throw new CompanionError('REMOTE_READ_ONLY', 'Connection changes require a valid loopback HTTP authority.', 403); }
  if (!loopback(authority.hostname)) throw new CompanionError('REMOTE_READ_ONLY', 'Connection changes are available only in Desktop or a loopback DSH interface.', 403);
  const origin = request.headers.get('origin');
  if (origin) {
    let sameOrigin = false;
    try {
      const parsed = new URL(origin);
      sameOrigin = ['http:', 'https:'].includes(parsed.protocol) && parsed.host === authority.host;
    } catch { /* Opaque or malformed origins are not trusted. */ }
    if (!sameOrigin) throw new CompanionError('ORIGIN_REJECTED', 'Cross-origin configuration changes are not allowed.', 403);
  }
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new CompanionError('INVALID_REQUEST', 'Send a JSON request.', 415);
}

export async function readInput(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new CompanionError('INVALID_REQUEST', 'Send a JSON request.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 131_072) { await reader.cancel(); throw new CompanionError('REQUEST_TOO_LARGE', 'The configuration request is too large.', 413); }
      chunks.push(value);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('object required');
    return input;
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    throw new CompanionError('INVALID_REQUEST', 'Send a valid JSON object.');
  } finally { reader.releaseLock(); }
}

export function registerCompanion(ctx, companion, makeTool) {
  const json = async action => {
    try { return Response.json(await action(), { headers: { 'Cache-Control': 'no-store' } }); }
    catch (error) {
      const safe = publicError(error);
      return Response.json({ error: safe.error }, { status: safe.status, headers: { 'Cache-Control': 'no-store' } });
    }
  };
  for (const endpoint of ['status', 'catalog']) {
    ctx.connection.fetch.register({ path: `/api/multivibe/${endpoint}`, methods: ['GET'], requestBody: 'buffered',
      fetch: request => json(() => endpoint === 'status' ? companion.status() : companion.catalog(request.signal)) });
  }
  for (const endpoint of ['discover', 'connect', 'disconnect', 'recover']) {
    ctx.connection.fetch.register({ path: `/api/multivibe/${endpoint}`, methods: ['POST'], requestBody: 'streaming',
      fetch: request => json(async () => {
        assertLocalMutation(request);
        return companion[endpoint](await readInput(request), request.signal);
      }) });
  }
  const output = { schema: { type: 'object', properties: {}, additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
  const safeExecute = action => async (args, exec) => {
    try { return await action(args, exec); } catch (error) {
      const safe = publicError(error);
      const failure = new Error(safe.error.message);
      failure.code = safe.error.code;
      throw failure;
    }
  };
  ctx.tools.register(makeTool({
    name: 'multivibe_status', description: 'Read whether the operator-configured MultiVibe model provider is connected. Does not configure providers, reveal credentials, run inference, or access administration.',
    parameters: {}, output, timeoutMs: 12_000, isConcurrencySafe: () => true,
    execute: safeExecute(async (_args, exec) => {
      exec.signal.throwIfAborted();
      const state = await companion.status();
      return { connected: state.connected, recoveryRequired: state.pending, provider: state.connection?.providerId ?? null,
        protocol: state.connection?.protocol ?? null, configuredModels: state.connection?.modelCount ?? 0 };
    }),
  }));
  ctx.tools.register(makeTool({
    name: 'multivibe_models', description: 'List routable models from the operator-configured MultiVibe gateway using its dedicated proxy key. Capabilities not returned by the gateway remain unknown. Read-only; no inference or admin access.',
    parameters: { search: { type: 'string', description: 'Optional case-insensitive model ID/name filter.' }, limit: { type: 'integer', description: 'Maximum number of returned models, clamped to 1–100; default 50.' } },
    output, timeoutMs: 12_000, isConcurrencySafe: () => true,
    execute: safeExecute(async (args, exec) => {
      const catalog = await companion.catalog(exec.signal);
      const search = typeof args.search === 'string' ? args.search.slice(0, 256).toLowerCase() : '';
      const matches = catalog.models.filter(model => `${model.id} ${model.name}`.toLowerCase().includes(search));
      const limit = Math.max(1, Math.min(100, Number.isSafeInteger(args.limit) ? args.limit : 50));
      return { models: matches.slice(0, limit), total: matches.length, truncated: matches.length > limit };
    }),
  }));
}
