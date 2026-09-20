# Local memory

Apple Foundation Local can call `long_term_memory` to search confirmed memories,
inspect their original quotations or propose an exact quotation from the latest
user message. Proposals are not facts and are never included in retrieval or sync.
The model has no confirmation, correction or deletion tool.

Use **Mémoire** in chat to add, review, correct or forget a memory. **Retenir** on
a message and **Retiens ceci : …** open the confirmation form. **Oublie ceci**
opens the memory list for explicit selection. Assistant text can only be retained
after user confirmation, recorded as such rather than as an independent observation.

## Evidence and retrieval

Each record has a topic, type, optional project, dated source quotation and
confirmation provenance. Temporary information requires an expiry date. Corrections
create revisions with ancestor IDs. Concurrent revisions or different assertions
under the same normalized topic/project are excluded until the user resolves them.
This is a conservative topic-based check, not semantic proof that every possible
contradiction has been found. French/English synonyms in different topics can still
require human review. Model instructions require clarification rather than inference.

A protected, atomic account/guest history journal is the durable source of truth.
An account-scoped SQLite FTS5 index is rebuilt from eligible records; it is excluded
from backup and protected by iOS file protection. The most relevant scoped match is supplied at the start of each local request;
up to three complete scoped matches are returned by an explicit memory search, with source quotations and dates. Missing/expired/proposed/
conflicting memories are never indexed as usable facts. Source messages and raw
conversation search explicitly distinguish user statements from assistant guesses.
No model fine-tuning or recursive summary is involved.

The index is not used by remote models. Excerpts repeated in a conversation can
still be included in that conversation's existing opt-in history synchronization.
A memory never grants Internet or native device permissions. Current location and
other changing observations must be rechecked using their tools.

## Correction, forgetting and sync

Forgetting removes content and provenance from the record/index and cached remote
payloads while retaining an ID-only tombstone. Tombstones dominate older offline
copies. Deleting a source conversation also forgets associated memories, using a
stable native source identity across devices. Forgetting a memory alone does not
delete its original conversation message.

Guest memories stay in the guest journal and are not automatically copied on login.
Account switches clear the active index/draft. **Synchroniser la mémoire** is a
separate explicit opt-in; unconfirmed proposals never leave the device. Enabling
automatic history synchronization also retries memory sync on reconnect. Manual
sync is available in the Memory screen. Disabling stops future memory sync and does
not erase the existing server copy.

The Cloud extension adds optional `memory` to `/native/v1/history`, sharing its
account binding and revision compare-and-swap. Older clients omit the field and
preserve it. A server without support is detected before sending memories; local
data remains usable. Deploy Cloud migration `0168_native_agent_memory.sql` before
the updated Cloud service; migrations 0147 and 0148 supply the existing history
tables. The identity migration bundle contains these dependencies. No deployment
or production migration is performed by this implementation task.

## Verification

- `AgentMemoryTests`: SQLite persistence/retrieval, accents and query quoting,
  project scoping, expiry/proposal/conflict exclusion, concurrent corrections,
  deletion dominating offline replicas, storage failures, account isolation,
  source deletion after remote projection, unsupported servers and repeated
  assistant guesses never becoming confirmed memories.
- `MemoryUITests`: create and confirm a memory, inspect its provenance, forget it.
- Mac validation harness: real Apple model retrieves a seeded source-backed code
  through the memory tool. This proves tool selection with a deterministic source,
  not an absence of all future hallucinations.
- Cloud tests: HTTP validation/auth/revision checks, legacy field preservation,
  plus the actual migration and store queries on disposable PostgreSQL.

Local test logs use `/tmp/MULTIVIBE-4-*.log`. Physical iPhone behavior and live
production synchronization remain separate from simulator/local-server evidence.
