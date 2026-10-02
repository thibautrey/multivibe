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

- **Persistence:** downloaded and Apple Foundation chat runs bind protected atomic checkpoints to the
  existing account (or separate anonymous device namespace), conversation UUID,
  user-turn UUID, model and engine pin. The native bridge acknowledges each
  checkpoint before execution continues. Retry resumes complete tool results or
  retries inference without replaying tools. Unknown pending effects block until
  the user verifies effects and explicitly skips replay; uncertainty is retained.
  Generation fences reject stale writers, account logout invalidates leases,
  conversation deletion removes journals, files are excluded from backups and
  capped at 8 MiB. These executable recovery checkpoints remain device-owned;
  they are not Hermes SessionDB and are not uploaded as resumable execution state.
  Workspace-free title calls and remote automation callers remain non-durable.
- **Completed transcript synchronization:** a conversation authorized for Hermes
  Cloud can publish completed downloaded-model or Apple Foundation turns after
  explicit source-export consent. The account-scoped state outbox retains stable
  operation IDs and full transcript/tool observations, then reconciles when the
  connection returns. It does not replay pending tool effects, execute commands,
  or import legacy encrypted conversations automatically. Conflicting session
  heads, deleted objects and unresolved runs require recovery rather than an
  inferred merge.
- **Cloud-to-local continuation:** an explicitly bound conversation can seed the
  degraded local loop with its full Cloud transcript, including hidden tool calls
  and results. Completed unpublished local turns are read from their protected
  checkpoints before continuation. Pending Cloud execution blocks this handoff;
  account/session fences protect asynchronous reads. Transcript portability does
  not provide the Cloud Linux environment or its tools on iOS.
- **Selected Cloud context:** memory, skill and project-file object IDs are
  selected explicitly per conversation. Core memory accepts only the Hermes
  `memory` and `user` targets; skill context contains literal `SKILL.md` and
  reference documents; text files must belong to the selected project. The pure
  context adapter checks account ownership, single heads, tombstones, stable file
  IDs and Cloud-compatible size limits. It passes documents as bounded untrusted
  text, without executing frontmatter or scripts. Native memories and device
  documents are not exported by this adapter, and selecting Cloud context does
  not grant native data permissions.
- **Workspace editing:** the native Hermes browser opens project/session text
  files for creation, editing and deletion. Writes use the same deterministic
  project/path UUIDs as Linux and the web, retain reviewed parent versions and
  preserve existing metadata. The protected account journal stores each operation
  before network I/O; pending text can be inspected locally and retries keep the
  same operation identity. Pending edits cannot be replaced silently. Changed
  heads require another review, and permanent tombstones cannot be recreated.
  Text is limited to 64 KiB per file, 200 files and 512 KiB per workspace. This
  editor does not transfer arbitrary binary files or provide a local shell.
  Reconnection exchanges state only; editing never launches inference or replays
  a tool. Account transitions hide the editor and invalidate captured drafts.
- **Compaction:** the native llama.cpp adapter now measures the fully templated
  prompt and tool schemas with its actual tokenizer. Its preflight reports the
  effective context and output reserve, and generation rejects overflow before
  decoding rather than deleting old exchanges. The default output reserve remains
  1024 tokens; a separate explicit reserve is available for future summary calls.
  Downloaded models now provide this preflight to the JavaScript loop. At the
  pinned upstream threshold, completed exchanges are summarized without tools or
  user-visible streaming; the latest user exchange and each tool batch remain
  intact. A checkpoint binds the summary to its exact canonical prefix before
  further inference. Only the model view is compacted: Cloud exports retain the
  full transcript. A summary must fit its own measured context and shrink the
  final model view; refusals, truncation and failed persistence abort safely.
  Inputs that still fit may defer compaction. Longer histories are processed in
  measured blocks of complete exchanges. Each block summary and any previously
  checkpointed summary are preserved verbatim, then concatenated for the model.
  They are not repeatedly rewritten by the summarizer: native tests with a small
  model exposed forgotten earlier facts under that strategy.
  Each block fits the summarizer context and preserves assistant/tool-result
  groups; at most 32 summaries and 120 seconds of compaction work are allowed.
  Intermediate summaries remain speculative until the final checkpoint, so a
  refusal, cancellation or failure publishes no partial state. Indivisible
  oversized exchanges and an aggregate summary that cannot fit remain explicit
  errors; no block is silently discarded. Apple Foundation on iOS/macOS 27 also
  uses native transcript token counting with the exact instructions, prompt and
  response schema. Its summary is accepted only when validated structured output
  is nonempty and reported output usage is strictly below the reserved tokens.
  Older Foundation runtimes retain explicit overflow errors because verified
  output usage is unavailable to this adapter. This bounded mobile extension
  does not implement upstream
  micro-pruning or its complete summary prompt, and is not full compaction parity.
- No Linux terminal, process runtime, dependency installer, background scheduler,
  Hermes SessionDB, memory consolidation, executable skills loader, delegation, provider
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

## Apple Foundation inference adapter

`HermesFoundationAdapter` uses iOS 26 `DynamicGenerationSchema` and
`LanguageModelSession.respond(to:schema:)` with `tools: []`. It returns a complete
OpenAI-shaped round to Hermes, which owns validation, journal checkpoints and
execution. Generated argument JSON strings may still be invalid; they pass through
Hermes recovery, never directly into native execution. Full transcript/tool
observations are included as untrusted data and context overflow is surfaced.
Only completed final text is displayed; proposed-call commentary is suppressed.
Model availability and native device/Internet permissions remain required. This
is API and codec validation, not proof of physical model tool-selection quality.

## Selected Cloud workspace and skill readers

The native adapter exposes selected Hermes text files through the existing
read/edit document tools. Edits persist graph mutations with their original file
and project parents before tool success. Reconnection drains this outbox without
replaying the edit. Pending edits are readable but cannot be overwritten while
awaiting acknowledgement. Binary files remain outside the text tool contract.

`skills_list` and `skill_view` read only explicitly selected `SKILL.md` and
reference documents, with the Cloud reader's JSON envelopes. They never activate
a skill or expose scripts, assets, templates, dependencies or environment values.
The snapshot retains the existing mobile limits of 200 files, 512 KiB total and
64 KiB per document. Foundation and downloaded-model callers use the same reader.

Native checkpoints bind the tool context to a digest. An incomplete turn cannot
resume after its selected context changes; it asks for a new message instead of
silently reading another revision. Completed transcript recovery and state-only
Cloud publication do not need the old executable context. This restriction also
applies to older incomplete checkpoints that lack the new context binding.
