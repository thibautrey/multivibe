// Portable subset of NousResearch/hermes-agent (MIT), pinned in upstream/hermes-loop/manifest.json.
// See HERMES-PORT.md for source/function mapping and intentional mobile differences.
export const hermesCommit = '6d49922875f60af5bc31e2bfbae78a81d2fa91fc';
const clone = value => JSON.parse(JSON.stringify(value));
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const errorResult = content => ({ content, isError: true });
const cancelled = signal => { if (signal?.aborted) throw new Error('Cancelled'); };

// Hermes message_sanitization.uniquify_tool_call_ids/coalesce_tool_call_id:
// deterministic duplicate suffixes keep every emitted call paired with its own result.
export function normalizeCalls(calls, round) {
  const seen = new Set();
  return calls.map((call, index) => {
    const raw = call.call_id || call.id;
    const base = typeof raw === 'string' && raw.trim() ? raw.trim().split('|')[0] : `call_${round}_${index}`;
    let id = base, suffix = 2;
    while (seen.has(id)) id = `${base}_d${suffix++}`;
    seen.add(id);
    return { id, type: 'function', function: { name: call.function?.name ?? '', arguments: call.function?.arguments ?? '{}' } };
  });
}

// Native tool schemas use this deliberately bounded JSON Schema subset. Unsupported
// constraints fail closed rather than silently widening a device permission contract.
export function validateArguments(schema, value, path = 'arguments') {
  const supported = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'enum', 'pattern', 'description', 'title', 'default', '$schema', 'anyOf', 'const']);
  for (const key of Object.keys(schema)) if (!supported.has(key)) throw new Error(`Unsupported schema constraint: ${key}`);
  if (schema.anyOf) {
    if (!schema.anyOf.some(branch => { try { validateArguments(branch, value, path); return true; } catch { return false; } })) throw new Error(`${path}: no allowed shape matched`);
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const matches = type => type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : type === 'array' ? Array.isArray(value) : type === 'integer' ? Number.isInteger(value)
    : type === 'null' ? value === null : typeof value === type;
  if (types.length && !types.some(matches)) throw new Error(`${path}: expected ${types.join(' or ')}`);
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) throw new Error(`${path}: unsupported value`);
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) throw new Error(`${path}: unexpected value`);
  if (typeof value === 'string') {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) throw new Error(`${path}: invalid length`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error(`${path}: invalid format`);
  }
  if (typeof value === 'number' && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) throw new Error(`${path}: out of range`);
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) throw new Error(`${path}: invalid item count`);
    if (schema.items) value.forEach((item, index) => validateArguments(schema.items, item, `${path}[${index}]`));
  } else if (value && typeof value === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key}: required`);
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) validateArguments(schema.properties[key], item, `${path}.${key}`);
      else if (schema.additionalProperties === false) throw new Error(`${path}.${key}: unknown property`);
    }
  }
}

export async function runHermesTurn(input, host) {
  const messages = clone(input.resume?.messages ?? input.messages);
  validateTranscript(messages);
  if (!input.resume && messages.at(-1)?.role !== 'user') throw new Error('A user message is required');
  const tools = input.tools ?? [];
  const names = new Map(tools.map(tool => [tool.name, tool]));
  const saved = input.resume?.state ?? {};
  const repeats = new Map(saved.repeats ?? []);
  // Recovered calls already had an opportunity to execute. Do not repeat even a
  // successful/explicitly skipped call if the model asks again after relaunch.
  if (input.resume) for (const message of messages) for (const call of message.tool_calls ?? []) {
    try { repeats.set(call.function.name + JSON.stringify(stable(JSON.parse(call.function.arguments))), 2); } catch {}
  }
  let { unknownStrikes = 0, jsonStrikes = 0, totalCalls = 0, modelMilliseconds = 0, weatherEvidence = false, weatherRepair = 0, recovery = 0, textContinuations = 0, rounds = 0, outputText = '', finalText, terminal = false, completed = false } = saved;
  const checkpoint = async () => {
    cancelled(host.signal);
    await host.checkpoint(clone(messages), { unknownStrikes, jsonStrikes, totalCalls, modelMilliseconds, weatherEvidence, weatherRepair, recovery, textContinuations, rounds, outputText, finalText, terminal, completed, repeats: [...repeats] });
    cancelled(host.signal);
  };
  const closeTail = text => { if (messages.at(-1)?.role === 'tool') messages.push({ role: 'assistant', content: text || 'Operation interrupted.' }); };
  const instruction = text => {
    const system = messages.find(message => message.role === 'system');
    if (system) system.content += '\n' + text;
    else messages.unshift({ role: 'system', content: text });
  };
  if (completed || terminal) return { messages, finalText: finalText ?? outputText, completed };
  await checkpoint();
  try {
    for (let round = rounds + 1; round <= 16; round++) {
      rounds = round;
      cancelled(host.signal);
      if (modelMilliseconds > 120_000) throw new Error('La limite de travail local a été atteinte.');
      // Current native contract has no compaction callback. Preserve the full
      // transcript and surface context overflow rather than silently dropping it.
      // A crash during inference can retry from this checkpoint: no tool is pending.
      await checkpoint();
      const start = Date.now();
      const reply = await host.model(clone(messages), tools);
      modelMilliseconds += Date.now() - start;
      cancelled(host.signal);
      outputText += reply.content ?? '';
      const calls = normalizeCalls(reply.tool_calls ?? [], round);
      let reason = String(reply.finish_reason ?? 'stop').toLowerCase();
      reason = ({ max_tokens: 'length', end: 'stop', function_call: 'tool_calls' })[reason] ?? reason;
      if (!calls.length) {
        messages.push({ role: 'assistant', content: reply.content ?? '' });
        await checkpoint();
        if (reason === 'length' && textContinuations++ < 2) {
          messages.push({ role: 'user', content: '[System: Your previous response was truncated by the output length limit. Continue exactly where you left off. Do not restart or repeat prior text. Finish the answer directly.]' });
          continue;
        }
        if (reason === 'tool_calls' || (!reply.content && totalCalls)) {
          if (textContinuations++ >= 2) throw new Error('Model did not complete its tool response.');
          messages.push({ role: 'user', content: reason === 'tool_calls' ? 'Your previous turn indicated a tool call but none was included. Issue the actual tool call now to continue the task.' : 'You just executed tool calls but returned an empty response. Please process the tool results above and continue with the task.' });
          continue;
        }
        if (input.weather && !weatherEvidence) {
          if (weatherRepair++ === 0) { instruction('Call weather_forecast to verify the forecast. Use city empty if the user did not specify a city. Do not invent one.'); continue; }
          finalText = 'Pour quelle ville souhaites-tu la météo ?';
        } else if (input.weather) finalText = reply.content ?? '';
        completed = true;
        await checkpoint();
        return { messages, finalText, completed: reason !== 'length' };
      }
      // Hermes validation: unknown-only batches stop after three strikes; a mixed
      // batch still runs valid calls. No fuzzy tool-name repair on permission APIs.
      const allUnknown = calls.every(call => !names.has(call.function.name));
      unknownStrikes = allUnknown ? unknownStrikes + 1 : 0;
      const malformed = [];
      for (const call of calls) {
        let args = call.function.arguments;
        if (typeof args !== 'string') args = JSON.stringify(args);
        args = args?.trim() || '{}';
        call.function.arguments = args;
        try { JSON.parse(args); } catch { if (names.has(call.function.name)) malformed.push(call); }
      }
      if (malformed.some(call => !/[}\]]$/.test(call.function.arguments))) throw new Error('Truncated tool arguments; no tool executed.');
      if (malformed.length && ++jsonStrikes < 3) continue;
      if (!malformed.length) jsonStrikes = 0;
      messages.push({ role: 'assistant', content: reply.content ?? '', tool_calls: calls });
      // Hermes run_tool_round ordering: checkpoint call intent BEFORE side effects.
      // Downloaded chat hosts acknowledge an atomic account-scoped journal write.
      await checkpoint();
      let hadError = false;
      for (const call of calls) {
        cancelled(host.signal);
        let result;
        try {
          if (malformed.length) result = errorResult(malformed.includes(call) ? 'Invalid JSON arguments. Please retry with valid JSON.' : 'Skipped: other tool call in this response had invalid JSON.');
          else if (terminal) result = errorResult('Waiting for the user; no further action executed.');
          else if (!names.has(call.function.name)) result = errorResult(`Unknown tool '${call.function.name}'. Available tools: ${[...names.keys()].join(', ')}`);
          else {
            const args = JSON.parse(call.function.arguments);
            validateArguments(names.get(call.function.name).parameters ?? { type: 'object' }, args);
            const key = call.function.name + JSON.stringify(stable(args));
            const repeated = (repeats.get(key) ?? 0) + 1; repeats.set(key, repeated);
            if (++totalCalls > 12 || repeated > 2) result = errorResult('Repeated identical tool call. Use the existing result, correct the inputs, or ask the user for missing information.');
            else result = await host.execute(call.function.name, args, call.id);
          }
        } catch (error) { cancelled(host.signal); result = errorResult(String(error.message ?? error)); }
        cancelled(host.signal);
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: JSON.stringify({ isError: result.isError === true, content: result.content }) });
        hadError ||= result.isError === true;
        if (call.function.name === 'weather_forecast' && !result.isError) weatherEvidence = true;
        if (result.terminal) { finalText = result.content; terminal = true; }
        await checkpoint();
      }
      if (malformed.length) jsonStrikes = 0;
      if (terminal) { closeTail(finalText); await checkpoint(); return { messages, finalText, completed: false }; }
      if (unknownStrikes >= 3) throw new Error('Model generated invalid tool calls three times.');
      if (hadError && recovery++ < 2) instruction('The tool failed. Read its error, correct the arguments or choose a suitable source. Do not repeat the same failed call. If essential information is missing, ask the user. Answer in the language of the user.');
    }
    throw new Error('La limite de travail local a été atteinte.');
  } catch (error) {
    // Preserve unresolved calls for recovery; never replay side effects implicitly.
    closeTail(String(error.message ?? error));
    throw error;
  }
}

export function validateTranscript(messages) {
  if (!Array.isArray(messages)) throw new Error('Invalid compacted transcript');
  const pending = new Set();
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!pending.delete(message.tool_call_id)) throw new Error('Orphan tool result');
    } else {
      if (pending.size) throw new Error('Missing tool result');
      for (const call of message.tool_calls ?? []) {
        if (!call.id || pending.has(call.id)) throw new Error('Duplicate tool call ID');
        pending.add(call.id);
      }
    }
  }
  if (pending.size) throw new Error('Unresolved tool call');
}
