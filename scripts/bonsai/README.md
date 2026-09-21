# Bonsai cache validation

The Responses → Chat bridge must give each tool a stable identity and deterministic
ordering. Tool schemas, descriptions and conversation messages remain intact.
A genuine schema/content change still breaks exact prefix matching; sorting cannot
make incompatible prompts share KV state.

For the PrismML build `prism-b10709-9a9394a`, the adjacent patch fixes two server
limitations for hybrid/recurrent models:

- Ordinary long system/tool prompts only received checkpoints at user boundaries.
  Periodic checkpoints now also honor `--checkpoint-min-step`.
- Slot snapshots omitted rewind checkpoints. An appended, versioned trailer now
  preserves their positions and model state in the same file as the KV snapshot.
  Original snapshots remain readable but explicitly warn that rewind state is
  absent. Invalid/truncated trailers fail restoration and clear the slot.

Apply the patch only to pinned source commit `9a9394a89` (resolve its full SHA before
building). Build `llama-server` in Ubuntu 24.04 with the same headers. Only the
resulting `libllama-server-impl.so` changes; retain the pinned model, CUDA, GGML,
llama, common and multimodal libraries. Check the actual mapped library after
startup. Keep the original library and launcher for rollback.

Validated runtime settings: one slot, 147456-token context, f16 KV, 64 context
checkpoints, minimum spacing 4096 tokens, and a 12288 MiB host prompt-cache budget.
RAM budgets count bytes, not tokens or conversations. Full prompts consume several
GiB; oversizing this cache can cause severe paging pauses. Check real host memory
pressure before increasing it. A first request after changing the tool format must
still populate the cache.

Use `benchmark-cache.py --help` with locally retained token arrays and an authorized
idle server. It makes three real one-token generations and writes only metrics.
Do not commit prompts, token arrays, request headers, credentials or saved KV state.
`timings.cache_n` measures reused input; `tokens_cached` alone is the final slot
size and must not be reported as the cache hit count.

Validation must cover:

1. Two captured Responses requests with the same tools in different orders produce
   identical declarations, preserve tool routing and share their rendered prefix.
2. A changed suffix reuses the closest compatible checkpoint; repeated input
   recomputes only the final few tokens.
3. Saving a sufficiently large populated slot, restarting, restoring and repeating
   step 2 preserves reuse. A successful restore response alone is insufficient.
4. Host SSE completion usage includes cached input tokens. Bonsai `none` reasoning
   reaches the server and its configured context capacity reaches the Codex catalog.

Never leave the active Host in drain mode while using it to run the investigation.
Do not overwrite unrelated working-tree changes or active inference requests.

## Live validation (2026-09-21, MULTIVIBE-21)

Captured Codex requests (196 real tools), routed through the installed Host:

| Case | Input tokens | Reused tokens | Elapsed |
| --- | ---: | ---: | ---: |
| Cold | 81945 | 0 | 288.922 s |
| Changed final question + reversed declaration order | 81946 | 81924 | 1.285 s |
| Same request after Bonsai stop/start and slot restore | 81946 | 81942 | 1.245 s |

The final Responses SSE usage reports `input_tokens_details.cached_tokens=81942`.
The server saved/restored 16 recurrent checkpoints. These measurements establish
actual reuse, not simply a populated slot. The cold and warm runs predated the
usage-detail forwarding fix; their reused counts came from server logs.

The deployed library lives in `/opt/bonsai/bin/MULTIVIBE-21`, alongside symlinks to
the original pinned runtime libraries. The launcher and compose backups use the
`.pre-MULTIVIBE-21` suffix. Reverting to the old runtime discards rewind persistence.
The Host helper backup is under its Application Support `backups/MULTIVIBE-21`.
On this 147456-token configuration, startup can fall back from pipeline parallelism
when its extra CUDA compute buffer does not fit; the measured restored run succeeded
with that fallback. This is not a promise of concurrent long-context capacity.

Main-branch validation: `cargo test -p multivibe-v1-edge --locked --offline`:
121 tests passed; release build passed. No captured prompt or token array is included.
