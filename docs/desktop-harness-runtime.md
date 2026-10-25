# Desktop harness runtime

MultiVibe Desktop controls a harness through a Host. The harness owns its agent loop, native tools, instructions and context. The Host owns the follow-up queue, durable commands, attachments and the event journal. macOS Desktop uses the same v1 API for a local Host, an SSH Host, and a Host inside a container.

## Contract

The contract is defined in `src/host/harness-runtime/types.ts`; the Codable projection lives in `packaging/macos/NativeHarnessRuntimeTypes.swift`. The additive API is rooted at `/admin/host-harness-runtime/v1`.

| Resource | Operations |
| --- | --- |
| `/catalog` | Installed adapters, availability and capability origins. Authentication remains unknown until actually established. |
| `/registrations` | Register an installed ACP executable and its argument array. Built-in adapter identities cannot be replaced. |
| `/targets` | Register an existing SSH alias or container, with an installed bridge path. |
| `/sessions` | List and create sessions; optionally migrate a previous Desktop transcript. |
| `/sessions/:id` | Read a snapshot, rename, pin, archive or delete an inactive session. |
| `/sessions/:id/commands` | Submit an identified command; repeated IDs with identical content return the stored receipt. |
| `/sessions/:id/commands/:commandId` | Resolve an uncertain HTTP acknowledgement before submitting again. |
| `/sessions/:id/events` | Ordered SSE; `after` resumes from the last saved cursor. Polling uses `poll=1`. |
| `/sessions/:id/attachments` | Upload session-owned content with optional SHA-256 verification. Individual files are limited to 16 MiB. |
| `/sessions/:id/attachments/:attachmentId` | Download and verify an input or generated artifact. |
| `/sessions/:id/export` | Export the journal and public state. Large exports return an explicit limit; events remain accessible by cursor. |
| `/native-sessions` | Discover CLI session metadata without reading authentication files. |
| `/native-sessions/:sourceId` | Read a native transcript without acquiring ownership; `after` pages through records. |
| `/sessions/import` | Continue a discovered session through an isolated native fork, when the adapter supports one. |

Capability `support` is `native`, `multivibe`, `unsupported`, or `unknown`. `available`, `reason`, and `constraints` carry the effective restriction. An omitted native capability is unknown. Installing an executable or configuring a model URL does not prove model access or successful inference. Session metadata records negotiated protocol and CLI versions when available; a missing version remains unknown.

Commands target a session and, for steering, an exact turn. The harness, execution target and authentication mode are fixed for that session. Model/settings changes use explicit commands between turns.

## Queue and lifecycle

The ordinary Send action queues a future turn. MultiVibe is the sole owner of that queue; adapters never submit the same follow-up into a second native queue. Pending messages can be edited, reordered, removed or suspended, with attachments retained. Pi's native steer queue is used only for explicit steering.

`steer` is distinct from queuing: the Host checks the active turn both before and after asynchronous adapter initialization, and the native Codex request also checks the native turn ID. Acceptance is recorded separately from completion. ACP, Claude SDK and OpenCode steering remain unavailable without an appropriate native contract.

Stop requests native interruption and suspends the follow-up queue. It preserves partial output, cancels pending questions and retains queued messages. If native completion or failure races with Stop, the native terminal result is retained. Background process termination remains a separate native operation. Pausing the queue does not claim to pause inference or tools.

Pi interruption sends the documented abort command directly. The adapter then rebuilds its RPC connection from the retained native session to discard any queued native steering. It does not wait for an unsupported queue-clearing command from another Pi version.

Closing a Desktop window or disconnecting SSE does not stop the Host-owned turn. SQLite stores sessions, operation fingerprints, queue ordinals, events, interactions and schedules. On Host restart, previously dispatched work becomes uncertain and is never automatically replayed. An authoritative late native event can reconcile a live uncertain turn. Otherwise the interface directs the user to native history and an isolated copy; it does not guess whether an external action happened.

The Host expires unanswered interactions after 30 minutes. Parallel questions remain pending independently. Authentication challenge URLs are available to the live authenticated client for reconnect, and excluded from persistent events and exports. Native OAuth credentials remain owned by the harness.

SSE records are deduplicated by cursor. Replay pages are bounded by record count and byte size. Backpressure closes a slow display stream so Desktop can reconnect using its saved cursor. JSONL transports preserve UTF-8 across byte boundaries.

## Feature surfaces

| Feature | Common behavior and native translation |
| --- | --- |
| Installation and diagnostics | Existing Host integrations provide detection, managed configuration, repair and pinned installation. Session startup negotiates/probes its actual version. Native authentication is preserved. |
| Sessions and history | Desktop search, rename, pin/archive, export and inactive-session deletion; native session discovery and read-only preview; isolated continuation for Pi, Codex, Claude and OpenCode. ACP continuation requires advertised native fork support. |
| Queue and steer | Persistent Host queue for every adapter; true steer for Pi RPC and Codex App Server; explicit rejection for unsupported steering. |
| Interrupt and retry | Native cancellation, retained partial output, suspended queue and explicit uncertainty. Retry is a new operation, never an automatic replay of an uncertain action. |
| Work lifecycle | Session/turn events, tool events, compaction, retries and interactions are journalled independently per conversation. |
| Modes and plans | ACP modes/config options, Codex collaboration modes, OpenCode agents/modes; native plans appear in the activity timeline. Additional SDK permission settings use the session settings surface. |
| Instructions and context | Ordered user/project instruction sources are inspectable. Native composition remains authoritative. Text/resources/files are explicit input parts; native token/context measurements are displayed when supplied. |
| Compaction | Pi RPC and Codex APIs; OpenCode summarize; ACP/Claude slash compaction only when discovered. Custom summary instructions are forwarded only where supported. |
| Durable memory | Native user/project memory sources can be read; supported writable files use revision checks and a private previous-version backup. Instruction files are not silently rewritten. Memory, transcript and active context remain separate. |
| Skills | Native discovery where available, otherwise bounded user/project source discovery. Known Codex/Pi/Claude invocation syntax is preserved; unknown skill invocation syntax is not invented. |
| Slash commands/templates | Native command discovery, inspector insertion and composer completion. A selected command remains a native prompt; Desktop does not reinterpret its arguments. |
| Tools | Stable call IDs, arguments, progress, results, errors and simultaneous calls. Binary results are extracted into session-owned attachments before journal redaction/truncation. |
| MCP/plugins | ACP-negotiated transports; Codex server status, OAuth and reload; Claude SDK status/set/reconnect/toggle and reload; OpenCode MCP status. Native extension events remain inspectable. |
| Questions/permissions | Permission option IDs round-trip to their original request. Questions retain their native answer shape. MCP forms preserve boolean/number/object/array types; URL authentication opens the embedded browser. |
| Attachments | Drag/drop/import, persistent drafts, session-scoped transfer, SHA-256 integrity, explicit MIME rejection and no silent OCR/transcription. ACP images/audio/resources follow negotiated capabilities; Pi/Codex/Claude handle image/text inputs; OpenCode uses file parts. |
| Replies/artifacts | Existing Markdown/interactive document rendering plus native activity, structured payloads, downloadable artifacts and image previews. Completed native message snapshots replace matching streamed parts. Child-agent text is kept out of the parent answer. |
| Terminals/processes | Native command outputs and exit codes; ACP client terminal creation/output/wait/input/kill/release execute on the owning Host. Native background-terminal controls remain separate from Stop. Interactive PTY resizing requires an actual native terminal capability. |
| Workspace/Git | Explicit Host workspace, native file-change/diff events and Codex background terminal inspection. Native tooling owns edits and Git operations. |
| Checkpoints/forks | Isolated context forks, Claude rewind dry-run/explicit rewind, OpenCode revert/unrevert and native checkpoint inspection. These operations do not claim to undo external effects. |
| Models/settings | Native model discovery and session-scoped configuration; declarative ACP model/mode/config options and an advanced settings surface. Native access and MultiVibe access are distinct. |
| Usage/budgets | Native usage events carry their origin and measured/estimated fields. They are not added to proxy totals a second time. Missing costs or quotas remain unknown. |
| Subagents | Native task/collaboration IDs, events and results appear in activity. This does not turn native delegation into MultiVibe orchestration. |
| Automations | Host schedules persist and coalesce missed deadlines without duplicating a pending scheduled execution. They survive Desktop closure and require their owning Host to run. Unadvertised native goals/webhooks remain unavailable. |
| Hooks/extensions | Native hook/plugin inspection and an advanced operation surface preserve adapter-specific behavior. Unknown operations fail explicitly. |
| Remote/resilience | Persistent SSH bridge, strict host-key verification, cursor replay and Host-owned attachment paths. Containers with an installed bridge use the same API; compatible direct CLI transports are also supported. |
| Privacy | Private SQLite/attachment permissions, session-scoped operations, bounded/redacted diagnostics and deletion. Host admin credentials are never inherited by harness processes. |

The activity/inspection surfaces preserve native data when no dedicated editor exists. A native method or mode that is absent in an installed version remains unavailable; the feature inventory is not a promise that every harness supplies every feature.

## Adapter and environment matrix

This matrix describes implemented translations. `N` means a native adapter operation, `D` means discovered/negotiated, `M` means provided by MultiVibe, and `—` means not exposed. The live evidence below is narrower than this protocol surface.

| Operation | Hermes ACP | Pi RPC | Codex App Server | Claude SDK | OpenCode HTTP/SSE | Gemini ACP |
| --- | --- | --- | --- | --- | --- | --- |
| Supervised queue/replay/attachments | M | M | M | M | M | M |
| Stream and interruption | N | N | N | N | N | N |
| In-flight steer | — | N | N | — | — | — |
| Manual compaction | D | N | N | D | N | D |
| Native tools and interactions | N | D | N | N | N | N |
| Model/mode configuration | D | N | N | N | N | D |
| CLI continuation through isolated fork | D | N | N | N | N | D |
| MCP/plugins/hooks | D | D | N | N | D | D |
| Native background task/agent inspection | D | D | N | N | N | D |
| Host schedules | M | M | M | M | M | M |

The generic ACP adapter uses executable registration rather than Swift changes. ACP v1 capability negotiation is mandatory. Pi is launched with its tools, skills, extensions and prompt templates enabled. Codex opts into its App Server protocol; Claude uses persistent SDK input; OpenCode has a per-session authenticated loopback server and a filtered event stream.

For direct container execution, discovery checks inside the container rather than reusing the Mac's binaries. Claude SDK and OpenCode HTTP supervision require a Host/bridge inside the container. SSH aliases use existing SSH authentication and `StrictHostKeyChecking=yes`; the bridge and Node.js must already be installed. The remote daemon can use the private managed credentials of a MultiVibe Host on its own machine. No native harness credentials are copied to Desktop.

Desktop browser/computer-use tools remain distinct from tools executing on another Host. A native MCP or harness bridge must explicitly expose routing between those environments; the runtime does not pretend that a remote shell is a local browser.

## Migration and compatibility

Existing Desktop `role/content` history remains decodable. A legacy conversation migrating into a new supervised session supplies its previous messages once as an attached transcript, preserving conversation context without replaying recorded operations. The migration attachment is retained and inspectable. Oversized or invalid migration input fails before replacing the user's local history.

Opening an already-known Host session selects the local conversation and preserves drafts, queued submissions and rendered messages. Session IDs from different execution targets do not replace each other's local records. A pending submission first queries its operation ID after reconnect; it uploads/sends again only when the Host has no receipt.

The legacy text endpoint delegates to the supervisor when the runtime is present. It remains a cumulative-text compatibility surface; rich interactions use the v1 API. Disconnecting a legacy display also leaves the supervised work running. Old native session identifiers must be imported through safe discovery instead of being attached to another active writer.

## Evidence and limits

Validation on 2026-10-25 used Hermes **0.21.5** (reported by ACP initialization, protocol 1), Pi **0.55.3**, Codex **0.154.0**, Claude Code **2.1.241** with Agent SDK **0.3.310**, and OpenCode **1.18.30** on macOS. Each completed a read-only tool task that read a freshly generated, undisclosed file marker. Pi/OpenCode used `gpt-6-luna`; Codex also passed with `gpt-6-sol`. Hermes used its native configured model.

Claude's complete tool round-trip used a separately built current-source Rust edge, forwarding Responses inference through the installed MultiVibe gateway. The test exposed and fixed headerless Responses-to-Anthropic streaming, tool-result input conversion, tool stop reasons and final-only output hydration. This proves the code in an isolated local environment, not deployment of that edge into the installed application.

An isolated Linux SSH run verified catalog access, native Codex session metadata and a suspended queue retained across reconnect. This is remote control/recovery evidence, not inference proof for all six harnesses on Linux or containers.

Gemini 0.65.0 was probed from an isolated npm cache, but Google authentication was unavailable. Its ACP translation has protocol fixtures; authenticated Gemini inference remains unverified. Installer pins are not claims that every pinned version has completed a real turn on every platform.

Contract/API tests cover ordering, idempotency, editing/removal, suspension, steer turn races, cancellation/completion races, concurrent interactions, compaction, late reconciliation, Host restart, attachment integrity/ownership, native discovery, bounded replay, migration and private remote credentials. Swift fixtures cover persisted history/drafts, rich message projection, cancellation, native routing, file imports and typed forms. The native edge's library tests also cover Anthropic streaming and tool continuation.

No general PTY resizing, native memory toggle, arbitrary hook editor, cross-Host browser routing, native goal/webhook API or universal native-session takeover is inferred from the presence of a CLI. These remain explicit unavailable/unknown capabilities until an adapter and an environment provide a verified contract.
