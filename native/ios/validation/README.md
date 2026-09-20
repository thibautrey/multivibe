# Local agent verification

The native app's XCTest suites cover guest/account isolation, expired-session
local generation, persistence failures, tool budgets and cancellation, deferred
synchronization and conflicts, and per-conversation Internet allow/deny decisions.
Consent is required before HTTP, shared by concurrent calls, retained after
relaunch, and never accepted from a server snapshot. The UI test uses a DEBUG-only
injected model/HTTP fixture and does not access accounts, saved history or network.

On 2026-09-20 the final iOS 26.5 simulator run passed 80 unit tests and 2 UI tests.
The real-Apple-model test and physical HTTP test were explicitly skipped there.
The same day an earlier iPhone iOS 27 run passed 75 tests, including two dependent
real Apple tool calls (137 + 286, then multiply by 7, answer 2961). After web tools
were added, real UI testing exposed an offline-capability refusal; this was fixed
by separating `fetch_website` and returning recoverable argument errors to the
model. The final corrected web flow was not rerun on the locked iPhone, as the
user requested continuing without unlocking it.

The real Apple model on macOS 27 then selected `fetch_website`, received one
approved deterministic response, and answered ORION-4729 from that evidence. A
separate actual HTTPS GET returned HTTP 200 and readable Example Domain text.
Reproduce this check with `bash native/ios/validation/check-local-agent-macos.sh`.
The harness does not validate iPhone permissions or synchronization with a live
account; it uses the actual model/tool code with minimal UI data-type stubs.

Relevant retained local logs from this run:
- `/tmp/multivibe-2-final-sim.log` — final simulator build/tests.
- `/tmp/multivibe-2-device-tests.log` — earlier 75-test iPhone pass.
- `/tmp/multivibe-2-device-web-tests.log` — diagnostic run with locked unit runner
  and initial model web refusal (superseded; not a passing result).
- `/tmp/multivibe-2-model-mac.log` — real model web choice and live HTTPS result.

DerivedData, compiler caches and the task's disposable simulator were removed.
No push, App Store release or server deployment was performed. Live account sync
and real Calendar/Reminders permission behavior have not been exercised; their
implementation is compiled, with synchronization covered by injected services.

On-demand device data extension (2026-09-20): calendar, reminders, contacts and
one-shot GPS use native iOS permissions only when called for an explicitly named
source in the current user request. The app checks French/English source wording
before reaching the permission API; ambiguous requests require clarification.
A model-only instruction was insufficient: a real-model location probe also tried
unrelated sources, motivating the app-owned gate and its regression test.
Apple Mail inbox reading has no public iOS permission/API; the tool explains that
messages must be imported or pasted. No mailbox connector or sending was added.
Location uses no geocoding/network service, and reports coordinates and accuracy.
System inactive transitions no longer cancel inference; backgrounding still does.

The real Apple-model Mac harness selected current_location and reproduced injected
coordinates, while web consent and live HTTPS checks also passed. This proves
model/tool wiring, not real GPS acquisition or native iPhone permission behavior.
The first iOS 27 simulator launch failed before tests; iOS 26.5 successfully ran
82 unit tests (two hardware-only skips) and all eight UI tests before the final
source-scope gate. The final gate passed 83 unit tests (two hardware-only skips), including its additional focused regression.
Logs: /tmp/MULTIVIBE-3-tests.log, /tmp/MULTIVIBE-3-final-tests.log,
and /tmp/MULTIVIBE-3-model-mac.log. Physical permission flows remain unverified.
