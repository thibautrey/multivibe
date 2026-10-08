# Isolated Hermes device QA

`MultiVibeHermesQA` uses the Debug-derived `QA` configuration and installs as
`cloud.multivibe.chat.qa` (display name `MultiVibe QA`). Its unit-test and UI-test
bundle identifiers are distinct as well. Keychain session services, model download
sessions and automation background identifiers use the installed app's bundle ID.
The production identifiers remain unchanged.

The QA app has no Apple Sign In or associated-domain entitlements and registers
only `multivibe-chat-qa`. It cannot claim the production app's custom URL or
universal-link callback. This configuration provides an isolated local-test host;
it does not establish real OAuth or Cloud transport acceptance.

The shared QA scheme selects only the namespace regression tests and
`DownloadedModelDeviceTests/testInstalledQwenUsesUpstreamDocumentEdit()`.
It does not run the disposable-simulator authentication UITests or the test that
modifies the installed model library. Profile/archive build flags are disabled;
all emitted scheme actions remain on the QA configuration.

Before physical execution, attest the built app's bundle identifier, display name,
URL scheme, signing identity and entitlements. Keep the commit, binary digest and
test result with the operator evidence. Do not use a global bundle-ID override:
it would also override the test targets. Build and dependency validation run from
main after integration, with task-specific DerivedData removed on exit.

Device inference requires explicit `MULTIVIBE_LOCAL_DEVICE_TEST=1`. If the QA
sandbox has no installed Qwen model, `MULTIVIBE_TEST_DOWNLOAD_FIXTURE=1` enables
an ephemeral Wi-Fi-only download. The test verifies the pinned model's byte count
and SHA-256, uses it outside the installed library and removes its temporary file.
Without these opt-ins, device inference is skipped. A simulator result is not
physical-device inference proof.

Cross-client acceptance additionally needs two dedicated QA accounts and live
Cloud/Relay runs, synchronized text and binary bytes, conflicts and tombstones,
account switch, migration and a cut after an actual effect followed by restart and
reconnection. Preserve the same run/operation identities and prove that the effect
occurred exactly once; a mocked service or replayed tool does not establish this.
