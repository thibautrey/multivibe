# Desktop computer use

On macOS, create a conversation, choose **Computer use** in the engine selector,
and select a Host model that supports images and function calls. Describe the task
and its target app or website. The native Apple Foundation text model cannot run
this engine. A model that does not invoke tools produces an explicit error rather
than a claimed execution.

The engine runs in the Desktop process. Host credentials stay in that process;
models receive tool definitions, approved observations and screenshots. No remote
HTTP endpoint exposes the desktop controller. A model response may contain several
tool calls, but Desktop executes them sequentially. A mutation requires the latest
observation; subsequent mutations using the same observation are rejected.

## Browser

The visible WebKit browser has its own ephemeral website data store, separate from
the dashboard and other browsers. Each top-level website origin requires approval
for the current task. Redirects and popups to unapproved origins are blocked and
reported to the model. Only HTTP(S) URLs without embedded credentials are accepted.
Downloads and automatic site confirmations are refused. Sign in manually when
necessary. Existing Chrome/Brave sessions are not imported.

Observations combine a JPEG screenshot, bounded page text and visible DOM controls.
Node handles live in a WebKit isolated content world, expire after actions or
navigation, and cannot be supplied as JavaScript by the model. Clicks and keyboard
shortcuts use native WebKit input. Text fields use their native DOM value setter
and dispatch input/change events, including controlled web forms. Scroll, back,
double click and native drag are supported. Use element IDs where possible; browser
coordinates use viewport CSS pixels. Cross-origin frames and custom canvas controls
may require visual input or manual takeover.

Password, OTP and card autocomplete fields are excluded from DOM observations and
masked in browser screenshots. Input to detected secure fields is refused. This
cannot identify arbitrary sensitive text in a page: approve only the intended site.

## macOS apps

Grant **Accessibility** and **Screen Recording** to the built Desktop app through
macOS when prompted. These system grants are separate from per-application consent
in MultiVibe. Open the target app before requesting it. Approve access for this task
or save an always-allowed app; revoke saved decisions in the computer use settings.

ScreenCaptureKit captures only the selected app window, including while another app
is in front. Accessibility supplies bounded element IDs. AXPress operates supported
controls; Unicode typing, keys, scrolling and visual mouse actions are directed to
the target PID. Visual mouse actions require an unobscured point belonging to the
approved app. The driver rejects moved windows, expired observations, changed PIDs,
and secure fields. Terminal, assistant, credential and system-settings apps are
protected. The session must be unlocked; locked-screen automation is unavailable.

## User control and history

Actions require confirmation by default. The user can explicitly disable individual
action confirmations for the current task; this resets at task completion. App and
site consent still applies. Sensitive submissions require explicit user instruction.
**Reprendre la main**, Escape, leaving the conversation, closing its window, or
physical input in the controlled surface stops the run. Work in unrelated apps does
not interrupt background AX operations. Stopping cancels pending model requests and
permission waits. Mouse and keyboard release events are sent during cleanup.

The panel shows the latest screenshot and operation journal. Screenshots and tool
contexts remain in memory; durable local history keeps action metadata without
entered text. No automatic Cloud export is added. Runs are bounded to 60 tool calls
and 15 minutes; they do not resume clicks automatically after an interruption.

## Validation

From the primary checkout:

```sh
npm run test:computer-use
xcrun swiftc -typecheck -parse-as-library -target arm64-apple-macos13.0 packaging/macos/*.swift
```

The harness exercises a real WebKit page through the Host HTTP tool-call contract,
including trusted native clicking, typing, screenshots and final DOM verification.
Policy tests cover consent before observation, refusal, cancellation, stale handles,
revocation and journal redaction. On a Mac with existing Accessibility and Screen
Recording grants, it additionally launches a disposable fixture app and verifies
ScreenCaptureKit, the AX tree, PID-directed Unicode input and AXPress against its
visible result. Without those OS grants, native app acceptance remains unproven.

`packaging/macos/validation/ComputerUseLiveHarness.swift` is a separate opt-in
acceptance harness for a real model through the running local Host on port 1455.
It reads the Host credential internally and restricts the automation target to a
local HTTP fixture. It is not part of ordinary tests and does not replace the
repeatable contract test. Build it with the computer use sources, HostAssistantClient
and AppleFoundationModel, then pass a local fixture URL and a vision/tool model ID.
