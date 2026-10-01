# Hermes mobile orchestration port

The mobile loop is a **partial portable port**, not the complete Hermes agent.
It replaces Pi orchestration. Upstream source is vendored without edits under
`upstream/hermes-loop` at `6d49922875f60af5bc31e2bfbae78a81d2fa91fc` (MIT);
`manifest.json` records file hashes checked by the bundle build. Existing tool
schemas remain pinned separately under `upstream/hermes`.

## Why a portable loop

The inspected upstream `pyproject.toml` explicitly supports Python 3.14, despite
allowing older Python metadata for upgrades. Its core dependency graph includes
pydantic-core, cryptography, psutil, httptools and watchfiles; the repository's
current iOS target embeds JavaScriptCore and llama.cpp, with no embedded CPython
runtime or cross-build pipeline for those native extensions. Server handlers also
assume processes, filesystem and background services unavailable under the current
mobile capability bridge. This establishes that the full distribution is not
currently embeddable by this project; it does **not** prove that a future iOS Python
port is technically impossible or rejected by App Review. No Python embedding or
physical-device acceptance has been demonstrated by these source changes.

## Implemented upstream mapping

| Pinned upstream function | Mobile behavior |
| --- | --- |
| `conversation_loop._run_conversation_turn` | Bounded model → validate → tool round → model continuation. Native provider owns token streaming. |
| `message_sanitization.coalesce_tool_call_id`, `uniquify_tool_call_ids` | Composite IDs pair on call ID; duplicate IDs receive deterministic `_dN` suffixes. Missing IDs receive deterministic round/index IDs. Executed upstream Python helpers form differential tests. |
| `turn_tool_validation.validate_tool_calls` | Empty/object arguments normalize to JSON; unknown-only batches stop after three strikes; valid calls in mixed unknown-name batches execute; complete malformed JSON retries twice, then all calls receive matching error results; truncated JSON executes nothing. |
| `turn_tool_round.run_tool_round` | Stage assistant call batch before execution, checkpoint each result, execute sequentially, preserve every result ID, and stop continuation on terminal native refusal. |
| `message_sanitization.close_interrupted_tool_sequence` | A terminal tool tail closes with an assistant message. An unresolved interrupted call remains unresolved in the last checkpoint rather than being silently re-executed. |
| `message_sanitization.normalize_finish_reason`, `conversation_loop._get_continuation_prompt` | Normalize `MAX_TOKENS`/legacy finish reasons; continue length-limited text with the upstream output-limit prompt. Retry missing tool calls and empty post-tool responses boundedly. |

Device-specific extensions retain strict native schemas, two identical executions
maximum, 12 tool calls, 16 inference rounds and a 120-second cumulative inference
budget checked between calls. This is not a timeout of a hung native inference;
the native executor remains responsible for cancellation/timeouts. Native refusal
or clarification closes remaining calls without executing them. Weather repair
and error guidance preserve the previous app behavior.

## Explicit gaps and behavior differences

- **Persistence:** downloaded chat runs bind protected atomic checkpoints to the
  existing account (or separate anonymous device namespace), conversation UUID,
  user-turn UUID, model and engine pin. The native bridge acknowledges each
  checkpoint before execution continues. Retry resumes complete tool results or
  retries inference without replaying tools. Unknown pending effects block until
  the user verifies effects and explicitly skips replay; uncertainty is retained.
  Generation fences reject stale writers, account logout invalidates leases,
  conversation deletion removes journals, files are excluded from backups and
  capped at 8 MiB. This is a device journal, not Hermes SessionDB or Cloud sync.
  Workspace-free title calls and remote automation callers remain non-durable.
- **Compaction:** native bridge has no context-budget/summary callback. The loop
  preserves the transcript and surfaces inference overflow. It does not silently
  truncate, claim server compression parity or replay executed tools.
- No Linux terminal, process runtime, dependency installer, background scheduler,
  Hermes SessionDB, memory consolidation, skills loader, delegation, provider
  failover, plugins, server guardrails, or self-improvement is ported by this module.
- Tool-name fuzzy repair is intentionally disabled for native permission APIs.
  Schema validation is a fail-closed mobile subset, not upstream Python validation.
- Native inference currently may omit finish reasons; length recovery operates
  only when that metadata reaches the bridge. Provider-specific reasoning,
  network-partial reply recovery and upstream continuation overlap joining are not
  implemented. Strict caller cancellation stops work and rejects pending requests.
- The `PiAgentHarness` Swift class, `PiToolResult` type and checked-in resource names
  remain ABI/build compatibility names. `HermesNative` is the primary JS bridge;
  `PiNative` is a compatibility alias. Pi still owns document-edit matching only.

## Validation

`node --test hermes-loop.test.mjs` uses only Node and Python standard libraries.
It checks pairing, mixed batches, malformed/truncated arguments, checkpoint
failure, errors, permission refusal, cancellation, continuation and bounds. The
upstream helper differential check executes AST-selected vendored Python functions;
it does not import Hermes or install its dependencies. These tests establish the
listed subset, not full Hermes equivalence.

From the main checkout with dependencies available, run `npm test`, `npm run build`
and `npm run check`, then native JavaScriptCore tests and the physical downloaded
model scenarios described in README. Source tests do not establish device proof.

The dependency-free `checkpoint-store.test.swift` runner compiles with
`Core/HermesCheckpointStore.swift` using system Swift and verifies reopen,
unknown-effect refusal, cross-account/anonymous isolation, stale generations,
write failure, explicit resolution and deletion. iOS file-protection and UI
behavior still require native/device validation.
