# Local memory

After each successfully completed response, a separate background request asks the
same conversation model to identify useful user information and update existing
memories. Apple Foundation uses a separate tool-free local session; remote models
use the same model ID and account transport as the conversation. A new user turn
cancels the preceding review. Failed/stopped responses do not trigger extraction.

The response must be a bounded JSON array with exact quotations and user message
IDs. Assistant claims cannot supply evidence. Updates preserve memory identity and
revision ancestry. Manual changes made during inference take priority. Invalid
output and network failures leave existing memory untouched and are retried after
a later successful exchange. The reviewed message marker is persisted with history.
Reviews above the 48 KB input budget are rejected without marking them reviewed.

Use **Mémoire** from the conversation-list menu to add, inspect, correct or forget
information. The chat has no **Mémoire** toolbar button or **Retenir** message action.
**Retiens ceci : …** is handled as a normal conversation message; **Oublie ceci**
opens the memory list for explicit selection.

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
No model fine-tuning or recursive summary is involved. The app records the exact
memory revisions retrieved and exposes their original quotations/dates under
**Souvenirs consultés** on the response. Generated citation text is not trusted.

The most relevant sourced memory is also supplied to the selected remote model.
Remote background reviews send new conversation messages and memories in the same
project scope to that model, independently of the optional history synchronization.
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

### Recorded local proof — 2026-09-20

Final main-branch iOS 26.5 simulator test run: 99 unit tests passed, two
hardware-specific tests explicitly skipped, and MemoryUITests passed the full
create/confirm/source/forget UI flow. Log: /tmp/MULTIVIBE-4-tests.log.
The final real Apple-model Mac run used the production SQLite index/tool code:
RIGEL-8931 was recovered from memory, GPS used only the requested location tool,
and website retrieval required one permission. A live example.com GET returned 200.
Log: /tmp/MULTIVIBE-4-model-mac.log. Generated prose did not consistently include
the memory UUID; provenance is therefore attached by the app through exact
retrieved revision IDs, independently tested through history projection and forgetting.

Cloud main built successfully. Twelve HTTP/validation tests and one actual
PostgreSQL migration/storage integration test passed without skips. Logs:
 /tmp/MULTIVIBE-4-cloud-build.log, /tmp/MULTIVIBE-4-cloud-tests.log,
 /tmp/MULTIVIBE-4-postgres.log.
The identity migration bundle verifier passed. The disposable PostgreSQL
container, task simulators and temporary DerivedData were removed.

Known limits: lexical retrieval is not semantic search, topic-based conflict checks
cannot detect every contradiction, and a generative model may still misinterpret
evidence. The app does not claim zero hallucinations. Physical iPhone validation
and production account sync have not been performed. No push, release or production
migration was made.
