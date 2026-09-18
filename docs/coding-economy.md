# Cost-optimized coding

The bundled **Cost-optimized coding** module publishes two extra models so a
coding agent can own a task on a strong model, delegate bounded work to a
cheaper worker, and report what that actually cost. MultiVibe configures and
measures; **the harness decides**. MultiVibe never blocks, rewrites, or
downgrades a request, and it never swaps the model in the middle of a live
conversation.

The module is installed **disabled**. It ships with MultiVibe and is configurable
before it is enabled.

## What it publishes

| Model | Role | Resolves to |
| --- | --- | --- |
| `multivibe/coding-parent` | the strong owner of the task | the configured `parentModel` |
| `multivibe/coding-worker` | the cheaper executor of a bounded work package | the configured `workerModel` |

Both names are reconciled into managed **routing aliases** whose description is
`Managed by the MultiVibe cost-optimized coding module`. The alias resolves the
name to the target model before provider selection, so only the target model
changes: messages, tool definitions, `instructions`, and `prompt_cache_key` are
untouched, and an existing session stays on the model it already used.

A name is never published when it cannot serve:

- the module is disabled, or the target setting is empty → not published;
- the target model is not in the instance catalog → not published;
- the target names another virtual model, or parent and worker are the same
  model → reported as a conflict in `/admin/coding-economy`;
- a hand-written alias already owns the id → reported as a conflict and left
  **untouched**. MultiVibe only ever writes or deletes aliases it created.

## Setup

1. Plugins → Installed → **Cost-optimized coding** → Settings. Choose the parent
   and worker models, optionally a worker reasoning effort, and save.
2. Enable the module. The two virtual models appear in `/v1/models`, including
   the Codex catalog that MultiVibe Host maintains.
3. In the harness, point the worker at `multivibe/coding-worker` and keep the
   parent on `multivibe/coding-parent`. With OpenAI Codex, MultiVibe Host does
   this for you: Codex → **cost-optimized coding** writes a managed `[agents]`
   block plus the delegation contract, and disabling it removes exactly that
   block.

Reconciliation also runs at startup and after every module change, so a restart
or a revert can never leave a stale managed alias behind.

## Role and task attribution

Trace records keep the model the client **asked for** (`model`) separate from the
model that **served** the attempt (`resolvedModel`), so a role is known without
touching the inference path. Two optional headers refine it when request-header
tracing is enabled: `x-multivibe-task-id` and `x-multivibe-agent-role`
(`parent` or `worker`).

Correlation is reported, never invented: an explicit task id, else the Codex
session/thread id, else an explicit `unattributed` bucket.

## Cost kinds

The ledger keeps four kinds separate and never turns an unknown into a zero:

| Kind | Meaning |
| --- | --- |
| `measuredApiCashUsd` | measured, priced spend — the only number reconcilable against a provider invoice |
| `estimatedSubscriptionQuotaUnits` | tokens served on plan-billed accounts, in tokens |
| `localComputeTokens` | tokens served by local runtimes; hardware, not cash |
| `counterfactualSavingsUsd` | the same measured tokens repriced at the parent's published rates — labelled an estimate, never a measured saving |

## HTTP surface

| Endpoint | Purpose |
| --- | --- |
| `GET /admin/coding-economy` | module state, resolved descriptors, managed aliases |
| `POST /admin/coding-economy/sync` | reconcile aliases with the current catalog |
| `GET /admin/coding-economy/tasks` | per-task ledger (`limit`) |
| `GET /admin/coding-economy/tasks/:taskId` | one task |
| `POST /admin/host-harnesses/openai-codex/coding-economy` | enable/disable the Codex profile (`enabled`, `workerModel`, `reasoningEffort`) |

Auditing a whole workflow, including cold and warm cache states separately:

```bash
npm run benchmark:coding-economy -- --trace /data/requests-trace.jsonl --parent-model gpt-5.2-codex
```

The report compares each complete task's measured spend with the modelled
parent-model baseline. A cold worker context is called out explicitly, because
repricing identical token counts understates the real cost of a worker that must
prefill its own context.

## Limits

- Delegation is the harness's decision. MultiVibe reports that a task fell below
  the configured margin; it does not block it.
- Acceptance (accepted / repaired / taken over) is not yet recorded; the ledger
  reports measured turns and cost, not whether a human accepted the result.
- Alias reconciliation is a managed write. Do not hand-edit a managed alias; the
  module will reconcile it back on the next module change.
- If the operator already has an `[agents]` table in `~/.codex/config.toml`, the
  managed block would duplicate it; remove or merge it first.
