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
