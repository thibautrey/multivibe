# Codex startup prefix ordering

Native Responses forwarding and the TypeScript Responses projections place
recognized fixed Codex developer instructions before session-dependent startup
context. The order is permissions, delegation mode, collaboration, memory rules,
agent instructions, fixed app context, skills, deferred tools, memory facts,
projectless workspace context and client time context.

The transformer splits the memory message at `MEMORY_SUMMARY BEGINS` and the app
message at its projectless workspace section. It retains their exact text and
developer role. It does not sort tools, rewrite base instructions or move user
instructions. Only the initial consecutive developer run after optional leading
system messages is eligible. Unknown instructions, message identities, content
metadata (including cache breakpoints), images and incremental conversation
references leave the entire request unchanged. Managed Cloud, compaction and
non-Responses routes retain their native boundary contracts.

For Chat Completions providers, system and developer input instructions are
represented as system messages; they are never downgraded to user requests.

This canonicalization changes the rendered initial context once when activated.
Earlier cache entries may miss until the new prefix is warmed. Repeated requests
and continuations canonicalize the same startup prefix deterministically; later
user, assistant, reasoning and tool items retain their original order.

The shared synthetic fixture tests Rust/TypeScript parity, exact content,
idempotence, unchanged history and opaque contract fallback. The change prepares
shared local KV checkpoints; it does not implement disk persistence or promise
a measured TTFT reduction. Local model templates must still preserve developer
instructions, and models with non-trimmable caches need checkpoints taken at
reusable boundaries rather than only at session completion.
