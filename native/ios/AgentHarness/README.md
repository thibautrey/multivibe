# Pi Agent Core on iOS

The app runs the published **@earendil-works/pi-agent-core** package inside
JavaScriptCore. `bridge.mjs` imports `runAgentLoop`; it does not copy or reimplement
that loop. Pi owns argument validation, tool execution ordering, result messages,
and continuation. App hooks bound work, stop repeated identical requests, and
preserve permission refusals. Swift retains llama.cpp inference, native permissions,
HTTP, storage and device tools. JavaScript has no network or filesystem bridge.

The bridge adapts Pi's transcript to llama.cpp's OpenAI-compatible chat format.
Model token streaming stays native. Weather requests select the forecast tool so
small models do not invent URLs or locations; missing cities require clarification.
HTTP errors are errors, and stored local tool events include inputs, results and
status. Apple FoundationModels retains its native framework tool loop.

## Reproducible dependency updates

From the main checkout:

```sh
cd native/ios/AgentHarness
npm ci --ignore-scripts
npm test
npm run check
npm run update:pi -- <exact-release-version>
```

The update command pins both Pi packages, refreshes the lockfile, rebuilds the
bundled resource and runs compatibility tests. Commit the source, lockfile and
`MultiVibeChat/Resources/PiAgentCore.js` together. `ios-agent-harness.yml` rejects
stale bundles or a broken bridge. Xcode packages the checked-in bundle into every
app release; no executable JavaScript is downloaded at runtime.

Before shipping an update, run `DownloadedModelTests` and the opt-in physical
`DownloadedModelDeviceTests/testInstalledQwenToolsThroughProductionCatalog` and
`testPiWeatherClarificationAndLiveForecast` with `MULTIVIBE_LOCAL_DEVICE_TEST=1`.
They use the installed Qwen3 1.7B model and do not download it. Physical acceptance
checks real HTTPS, a denied request, a missing city, and a live forecast. Node
checks alone do not establish JavaScriptCore or physical-model compatibility.

## Upstream

- [Pi repository](https://github.com/earendil-works/pi)
- [Pi agent core](https://www.npmjs.com/package/@earendil-works/pi-agent-core)
- [Pi agent-loop source](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)

Pi and the bundled compatibility packages retain their license notices in
`Resources/PiAgentCore-LICENSES.txt`. OpenCode and Hermes were reviewed as
alternatives; their full Node/Python applications are not embedded in iOS.

### Hermes contracts and mobile tools

The iOS adapter vendors MIT-licensed Hermes Agent source at the exact commit in
`upstream/hermes/manifest.json`. `hermes-sync.py` extracts its Python schema AST
without importing or executing the Python modules. `ios-tools.mjs` narrows those
contracts to capabilities actually supported by the native app:

| Tool | Reused upstream code | iOS behavior |
| --- | --- | --- |
| `clarify` | Hermes question/choice schema | Ends the turn with questions in chat; never manufactures user responses. Choices are text, not a native form. |
| `session_search` | Hermes query contract | Literal search in this account's local history; no server DB, FTS operators or other profiles. |
| `web_extract` | Hermes URL-list contract | Up to three public HTTPS text/HTML/JSON pages, using native consent and bounded pagination. No PDF or browser execution. |
| `edit_document` | **Unmodified Pi `createEditTool()` execution** | Exact, unique, non-overlapping edits to imported document UUIDs; preserves BOM/newlines, saves the same document atomically, rejects stale snapshots. |

Hermes Python handlers are not embedded in the app: they depend on its server
runtime, database, plugins or credentials. Their contracts are reused with explicit
native adapters; Pi's JavaScript edit implementation runs directly in JavaScriptCore.
The app's memory, device permissions, date, calculator, document reading/creation,
weather and HTTPS reader remain available. Weather uses its small dedicated tool set.
No terminal, cron, messaging, delegation or arbitrary filesystem tool is exposed.
Web search is not advertised without a configured reliable search backend. Hermes
planning/todo persistence would require a separate conversation-state integration;
it is not represented as iOS Reminders.

To update Hermes, select and review an upstream commit, then from this directory:

```
python3 hermes-sync.py --update <full-40-character-commit-SHA>
npm run build
npm test
npm run check
```

The updater downloads a pinned snapshot, records SHA-256 hashes, and regenerates
contracts; unknown schema expressions fail closed. Review changes to the native
capability subset before shipping. Hermes notices are included in the app's existing
`PiAgentCore-LICENSES.txt`. Pi updates continue through `npm run update:pi -- <version>`.
Both updates ship in an app release, not as downloaded executable code on the phone.
