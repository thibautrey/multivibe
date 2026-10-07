# MultiVibe Companion for DSH

Connect DSH to a MultiVibe gateway and inspect available models and connection status.

A connection companion with a **MultiVibe global panel in the sidebar**, using the official Harness panel and plugin-manager contracts. The plugin reuses DSH's `llm-pi-ai` provider for inference and exposes two read-only tools. It does not import provider OAuth tokens, administer MultiVibe, or execute inference during discovery.

## Compatibility

- Node.js 22 or later.
- DSH SDK `0.2.0-rc.2` or compatible `0.2.x`, with the official connection, credentials, settings, tools, LLM and `llm-pi-ai` packages composed.
- Desktop or a loopback DSH Web interface is required to change the connection. Remote Web pages are read-only.
- A running MultiVibe gateway, normally `http://127.0.0.1:1455`. Use the public gateway port, never the loopback control-plane port `1456`.

Peer dependencies explicitly include the tested prerelease branch. Compatibility with older Harness releases is not claimed.

## Install

Use the DSH plugin manager with the prebuilt release asset:

```sh
dsh plugin add https://github.com/thibautrey/multivibe/releases/download/dsh-multivibe-v0.1.0/dsh-multivibe-0.1.0.tgz
```

The package contains built Host and browser modules and its Cordis bundle patch. No install-time build script is required. Restart the Harness after installing a package version, then open **MultiVibe in the sidebar**. You can also open **Plugins → MultiVibe → Open MultiVibe panel**. In Desktop, install into its active profile through the plugin manager; a separate CLI home is not automatically the Desktop home.

## Panel and existing providers

The sidebar entry uses `sidebar.panellist` and the matching `main` panel key. The installed bundle uses `plugins.bundle.config` to open that single panel. It is not a built-in Settings tab or a Desktop workbench bound to sessions. The panel distinguishes plugin activation, its own managed connection, and existing MultiVibe providers configured independently in DSH. Existing providers are read-only: their gateway, protocol, configured model IDs/limits and credential availability are projected without returning any key or changing configuration. Configuration and credential availability do not prove the gateway or inference works.

Providers are identified by MultiVibe names, the default loopback gateway on port 1455, or an already managed gateway URL. An arbitrary remote provider with no MultiVibe name cannot be identified reliably and is not shown. Keys unavailable to the Desktop process are displayed as missing; this does not mean a provider's external CLI configuration is invalid.

The global panel preserves the current conversation. Opening from the bundle detail selects the same panel instead of mounting another configuration form. Leaving it aborts pending requests and clears the typed password.

Official contracts used:

- [Harness sidebar global panels](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-sidebar/README.md) and [layout](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-layout/README.md).
- [Harness slots](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/slots.md) and [plugin manager](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-plugin-manager/README.md).
- [Desktop plugin contract](https://github.com/dataelement/dsh-desktop/blob/main/docs/patch-plugin-contract.md).

## Connect

1. In MultiVibe, create a dedicated **proxy API key** for the DSH application. Never use the MultiVibe administrator token here.
2. Enter the gateway root or `/v1` URL and the dedicated proxy key in the plugin's password field.
3. Choose the available DSH model-adapter configuration. If several namespaces are present, choose explicitly.
4. Discover models and select their exact routable IDs. Aliases work when returned by the gateway.
5. Confirm any missing context/output limits from authoritative model information. The plugin does not infer these numbers from model names or silently accept DSH defaults.
6. Choose **Chat Completions** or **Responses**, then connect. Select the resulting MultiVibe provider/model in DSH's normal chat picker.

Discovery makes only an authenticated `GET /v1/models` request. It does not prove that a real coding task, tools, image input or a particular reasoning level works through the model. Run a normal DSH request to validate your chosen model; that request may incur usage.

Only HTTPS is accepted for remote gateways. HTTP is allowed on loopback (`localhost`, `127.*`, `::1`). Gateway redirects are not followed. Gateways behind arbitrary URL path prefixes are not supported in this MVP.

## Tools

- `multivibe_status`: managed connection state, provider ID, protocol and configured-model count. No endpoint or credential is returned to the model.
- `multivibe_models`: authenticated live model catalog, optional search and a result limit clamped to 1–100. Missing capabilities remain unknown. No inference or administration call.

Configuration actions are **operator-only HTTP/UI actions**, not agent tools. Existing DSH tool policies still apply. The plugin does not add shell, filesystem or administrative tools.

## Secrets, ownership and recovery

- Keys are stored through DSH's credential service. Provider configuration contains a random credential reference, never the key.
- The browser holds a typed key only in the password input/request lifetime: no localStorage, URL, console log or persisted React key state. The field is cleared after successful changes and on unmount.
- Existing, inherited or adapter-owned provider IDs are never overwritten. Choose a new ID if `multivibe` already exists.
- Configuration updates use the actual adapter namespace and an expected settings revision. Unrelated providers remain unchanged.
- Credential and provider changes are **not** an atomic cross-service transaction. A durable, nonsecret operation journal and guarded compensation handle partial failure. Use **Recover incomplete operation** when prompted. Connect recovery removes its new managed provider; disconnect recovery finishes provider removal and respects the recorded credential-retention choice.
- Disconnect removes the authored managed provider. **Its credential is retained by default**: DSH settings forms do not expose inactive entries or non-live fields, so global non-use cannot be proven. The settings panel keeps a nonsecret list of retained references for operator maintenance.
- Deleting the credential is a separate, unchecked-by-default confirmation during disconnect. Only select it after checking that no other profile or setting uses the reference. The plugin additionally refuses deletion if an active editable settings view references it; this is not a global scan. Recovery retains this recorded choice. Fresh, failed connect operations compensate their newly allocated credential.
- If the provider is edited externally, the plugin refuses to remove or overwrite it. Restore its original authored configuration in DSH, or remove it manually and then disconnect in the companion to clean up its unused credential. It does not revoke the proxy key at MultiVibe; revoke it in MultiVibe when no longer needed.
- The Host plugin is trusted code, not an independently sandboxed security boundary. DSH's credential storage mechanism is reused; no encryption-at-rest/keychain guarantee is added by this plugin.

No quota, billing or route-simulation UI is claimed. Those features require an application-scoped supervision API in MultiVibe; the plugin deliberately does not use `/admin` or request an administrator token.

## Development

From the Multivibe repository root, with its dependencies installed:

```sh
npm run test:dsh-plugin
npm run build:dsh-plugin
npm pack ./plugins/dsh-multivibe --ignore-scripts
```

Or install development dependencies in the subpackage and run `npm test` / `npm run build` there. Committed `lib/` bundles make GitHub and tarball installation build-free; rebuild them when editing `src/`.

Tests cover URL/key validation, bounded and cancellable HTTP, catalog normalization, explicit capacities, transaction journals, revision conflicts, rollback, ownership, credential reuse, routes, tools and browser handlers/lifecycle. Browser handler tests use a small hook harness, not a real Desktop UI.

Optional installed-SDK contract tests load DSH's real tool compiler, SettingsForms implementation and React renderer, and run a real HTTP server through Connection's authenticated bridge (cookie exchange, local POST and cross-origin rejection):

```sh
DSH_SDK_ROOT=/absolute/path/to/isolated/sdk-root npm run test:dsh-plugin
```

`DSH_SDK_ROOT` must contain the relevant installed `node_modules` and a package root readable by Node. ASAR archives must first be extracted to an isolated development directory, without changing the live Desktop profile. These tests do not constitute an actual Desktop installation/open test.

## Marketplace

This global connection companion belongs to [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin), not the separate workbench catalog. The monorepo entry points to `plugins/dsh-multivibe` and a pinned, prebuilt GitHub Release tarball. A submitted PR is not a published/approved marketplace listing.

## Licence

Apache-2.0. Copyright 2026 Thibaut Rey and Pleiades Solutions.
