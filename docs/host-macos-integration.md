# MultiVibe Host on macOS

MultiVibe Host exposes its configured models through native App Intents on macOS
13 and later. This makes Host actions available to Siri and Shortcuts; it does not
replace Siri's language model or register MultiVibe as an Apple model provider.

## Entry points

- **Demander…** in the menu-bar popover opens a native question window. Select a
  model, enter text, and send. Responses can be selected or copied. Cancel stops
  the client request; a provider may already have incurred usage.
- **Demander à MultiVibe** in Shortcuts accepts a question and a model and returns
  its text, with a Siri dialog. The model picker queries the live Host catalog.
- **Choisir le modèle MultiVibe par défaut** saves a model for the native window
  and the Shortcuts model parameter's default suggestion.
- **Lister les modèles MultiVibe** returns model entities for further actions.
- **Ouvrir une demande MultiVibe** prepares editable text without sending it.
- **Interroger un fichier texte avec MultiVibe** accepts a UTF-8 file, question and
  model, and returns a response. Input is limited to 32,000 characters including
  the question (128 KB maximum file data).
- **Services → Demander à MultiVibe** prepares text selected in an application
  supporting macOS text services. Keyboard shortcuts for Services can be assigned
  in macOS Keyboard settings.
- **Share → MultiVibe** prepares shared text or web addresses in the Host. Enable
  the share extension in macOS extension settings if it is not visible. Web
  addresses are supplied as text, not automatically fetched.
- Opening Host from Finder or Spotlight again opens the native question window.
  `multivibe://ask` opens an empty window; `multivibe://compose#…` prepares a
  percent-encoded text fragment. External links never send a model request.

## Privacy and execution

Only explicit Send or the **Demander** / file interrogation actions execute
inference. Input may reach the selected model's remote provider. Services and
sharing prepare drafts for review. The share extension is sandboxed and has no
network or Host credential access. Drafts and replies are held in memory, not
indexed or written into conversation history by this integration.

The native Host reads its existing proxy credential and uses authenticated
loopback `/v1/models` and `/v1/chat/completions` calls. It follows the Host's actual
port, including its fallback port, rejects HTTP redirects, and uses an ephemeral
session. Credentials never enter Shortcut parameters or outputs. A missing saved
model produces an error rather than silently routing to a different model.

App Intents foreground the Host and inference actions require local device
authentication. Explicit invocation can start the service even with launch at
login disabled. Discovery may require the Host to be started first. Model replies
are returned to Shortcuts; subsequent actions control where that text goes.

## Packaging and verification

`scripts/provider-host/build-macos-native.mjs` compiles the native executable,
extracts `Metadata.appintents` from Swift constant values, and builds the nested
share extension. Release packaging signs the extension with its sandbox
entitlement before sealing the Host app. The share extension inherits the Host's
version and build number.

`node --test scripts/provider-host/macos-assistant-client.test.mjs` executes the
real Swift HTTP client against an authenticated loopback fixture, covering model
listing, input limits, stale models, response decoding, HTTP errors, redirect
rejection and cancellation. This does not establish Siri recognition, extension
visibility or a provider's live answer; those require installed-app acceptance.
