# LLM prefix audit — 2026-10-08

The local implementations put fixed task instructions before variable context, use source-first payloads where the source can be reused, and preserve caller-owned conversation order. No cache session option was added. These changes improve prefix identity; they do not establish a speedup on the future Mac Studio or prove SSD cache restoration.

## Scope and inventory

[Candidate inventory](./llm-prefix-inventory.json) records the expanded scan of 70 canonical Git groups and the supplementary indirect-call scan. Candidate matches were reviewed as inference builders, protocol relays, embedding calls or false positives. A text search alone is not completeness proof: dependency and indirect service calls were also inspected, revealing Shop Chat Agent outside the initial scan. Generated copies and old task worktrees were excluded from edits.

| Application | Local commits | Result and validation |
| --- | --- | --- |
| Shopify Translator | c1e7d88, 0e21c25, e923b23, b9cc6de, e1bcef9 | Shared source-first builders for sync/batch/retries and validation families; alternative provider contracts retained; optional cache metrics; streaming benchmark. API compilation and 18 prefix/batch/retry tests pass. Other isolated suites are recorded in its `docs/llm-prefix-cache.md`. Twelve older recovery/truncation failures also fail on baseline 49ae4eb. |
| Price Tracker | a97e1131d, abf1d3653, 21c4d6335, 488c2abbc | Translation, assistant/security guards, social, email/shipping/search Pi agents, event/blog/customer/order/review tasks and Astronomy editor/review prompts stabilized. Tool schemas sorted on copies. Backend tsc, changed-file ESLint and Astronomy API typecheck pass; temporary actual-builder assertions preserve sources, instructions and tool inputs. |
| Competitor Excel Updator | fce357f, e07daee | Product quality/schema instructions, SEO, anomaly and source discovery builders stabilized; tool-name copies sorted; missing usage remains unknown. Build and existing prompt/evaluation/cache/safety/SEO/anomaly/discovery suites pass. No production-DB tests run. |
| Devis PDF Builder | 408dd06 | Exact quote JSON precedes scope/request on OpenAI and Mastra paths; cache observation added. Build, 19 assistant-tool tests and actual built-call mocked-fetch prefix assertions pass. |
| Translation Shopify (legacy) | ca02376 | Fixed template separated from exact source JSON, retries reuse builder, legacy placeholder fallback retained. Syntax and exact-source/prefix assertions pass. |
| Chaton | 4f54d43 | Fixed runtime guidance before session context; explicit harness prepend/append boundaries preserved; autocomplete contract before cursor. Required MDX/architecture/audit documentation updated. Electron typecheck, 29 tests and all 16 section combinations pass; shared scaffold 4,013 characters. |
| Dashboard | 34d0794 | Fixed guidance before behavior/access metadata; related docs updated. Electron typecheck passes after main dependency installation with scripts disabled. |
| Shop Chat Agent | 0ef2e4e | Copied tools sorted; streamed first-content TTFT/cache accounting, Anthropic partitions kept distinct. Syntax and mocked actual-service assertions pass. Full app build unavailable without main dependencies. |
| MultiVibe Core | f7a1a557, 41dbc09d, a3793089, a45ea0bd, ac226d16 | Event-time cache analyzer, sorted native Hermes tool copies, Swift sorted JSON, local memory after history, optional SDK cache/input counts, Rho patch. API build; 104 SDK, 55 native Hermes, 19 Responses, 2 analyzer and 2 Rho tests pass. Swift parse passes; no full iOS build/device acceptance claimed. |
| MultiVibe Cloud | 11d8afb5 | Valid optional cached-token counts survive Chat/Responses conversions, including zero; absent/invalid remain absent. Twelve broker tests pass; no billing totals changed. |

User-configured workflow/supplier prompts and caller-owned histories retain their instruction authority and order. Price Tracker's remaining short user-data templates already have fixed system instructions or are caller-owned. Parlant's fixed schema system precedes generated data. Image generation and embeddings are not treated as autoregressive text KV reuse.

Audit-only applications: Even Stars has a fixed system and append-only history until explicit compaction (actual-module prefix assertion passed); CCE compressor uses fixed system/source user input, embeddings are outside this scope; Voyages and MultiVibe Landing are protocol/browser relays that preserve caller messages. Even Messages, referral seed URLs, Java collection `messages.stream`, and configuration/i18n matches are not owned inference builders. No direct owned builder was found in the other scanned repositories, including PlateformeArtisans and Investment Tracker.

## Harnesses

**Codex:** Mac CLI 0.154.0, remote CLI 0.160.1. Existing parity defaults retain caller cache keys and only default a missing key from session ID. Static developer instructions are retained. The corrected event-time-filtered one-day sample generated at 2026-10-08T18:59:02Z has 6,014 calls, 747,968,051 input tokens and 727,177,088 cached input tokens: 97.2203% aggregate, 99.1648% median per-call ratio. All sampled calls report cache counts. This is configured-backend evidence, not local SSD proof. An earlier file-mtime-only window was discarded; the analyzer now filters event timestamps and excludes unknown measurements from ratio denominators. Regenerate with `node scripts/analyze-codex-prompt-cache.mjs --days 1 --output /tmp/cache-observation.json`.

**Hermes:** Mac revision 6d49922875, remote revision 6590f13a1b. Cache boundary/scope/caching/system-prompt modules have identical hashes across both installations. Stable, context, volatile ordering; date-only tail; system bytes frozen/restored through a conversation; compaction is an explicit rebuild boundary. The five relevant suites pass 190 tests in an isolated profile. No remote changes or restarts.

**OpenCode:** installed package 1.18.30 reports binary 1.18.31. Official matching v1.18.31 source was read for session request/system/prompt/message, AI SDK and provider transformations. Fixed provider/agent instructions precede environment/project/user context; tool definitions are sorted copies. Date changes daily, so cross-day history reuse can break at that boundary. The installed session-header plugin only changes headers/sampling/output limits. No prompt rewrite, installed binary mutation or configuration change. Audit is source/config evidence, not a live cache benchmark.

**Claude Code:** installed 2.1.241. Settings inspection found no prompt-cache-disable flags or SessionStart/UserPromptSubmit/PreCompact hooks. Official [prompt caching](https://code.claude.com/docs/en/prompt-caching) and [costs](https://code.claude.com/docs/en/costs) Markdown endpoints were readable. They document automatic prefix caching and append-only content, with expected rebuilds on model/tools/context changes. Current documentation's cache statistics require 2.1.251+, later than this installation; do not attribute that UI to 2.1.241. No recent local usage records were available for measured cache confirmation, and no paid inference or upgrade was performed. Closed binary behavior was not independently reconstructed.

**Standalone Pi/Rho:** Pi launcher reports 0.55.3; Rho 0.1.12. Reading installed Rho revealed that `before_agent_start` recomputed heartbeat countdown and vault count in system context before its fixed tool instructions and brain. The controlled patch moves only runtime data to Pi's appended custom message while retaining all original fixed tool instructions, bootstrap, brain and caller system bytes. Pi's installed extension API and agent-session source confirm custom messages are appended to the current turn. The two tests exercise the real reviewed function/hook: dynamic heartbeat/vault values change, system bytes remain identical, exact original sections survive, repeat patch is idempotent, unknown versions are refused.

Reproduction:

```sh
node scripts/patch-rho-prompt-cache.mjs /absolute/path/to/rho/extensions/rho/index.ts
RHO_CACHE_TEST_SOURCE=/absolute/path/to/original/index.ts node --test scripts/patch-rho-prompt-cache.test.mjs
node scripts/patch-rho-prompt-cache.mjs /absolute/path/to/rho/extensions/rho/index.ts --apply
```

The patch was applied locally after tests. Baseline SHA256: `9a8a1ba36fd84ad2bac897b09d39e21fddb791e619adc9d9838007f8a433648e`; patched: `e5de3e3e406f094dfd5d36e766f49730cf2ac28b95e961045213c291163a0c2b`. Original bytes are backed up beside the source as `index.ts.prefix-cache-v1.bak`. Package updates can overwrite it; review a new upstream version before adapting the hash guard. Existing sessions were not restarted; reload the extension/start a new session to use it. A brain-content change still legitimately rebuilds system/history cache. No live Pi inference benchmark was run.

During audit, `pi --version` unexpectedly invoked package synchronization and reported three extension command conflicts (`/code`, `/review`, `/usage`). This side effect was disclosed; no guessed package rollback was attempted. Subsequent Pi inspection was read-only; the version launcher was not invoked again.

No Gemini/Aider/Goose/Ollama/llm/dsh executable was found on the audited PATH. Repo Pi wrappers are covered by the application changes above. This installed-harness inventory does not assert that no other binary exists outside PATH.

## Measurement boundaries and target-server procedure

Unknown server usage remains unknown; zero is preserved only when reported. Anthropic uncached/read/write partitions are separate, and inclusive input totals require complete evidence. Queue wait, HTTP/completion duration and TTFT are distinct; non-streaming calls cannot report measured TTFT. Logs contain metadata, never source prompts or credentials.

Use Shopify Translator's streaming benchmark with identical model, tokenizer, conversation template, generation options and inputs for legacy/source-first formats. Measure verified cold cache, exact repeat, same source/other language, other source, then controlled RAM eviction/SSD reload. Compare cached tokens, median/p95 first nonempty-content TTFT, total duration, structural validity and reviewed translation quality. Confirm SSD reload through server logs/metrics; a fast response is insufficient proof. Existing Bonsai checkpoint/restore support is retained; no proprietary cache flag was added to requests.

All application changes are committed on local main. No push, deployment or remote restart was performed. Unrelated dirty/untracked user files were preserved. Local prompt stability and validation are delivered; future hardware latency, SSD reload and semantic quality on its target model remain unmeasured.
