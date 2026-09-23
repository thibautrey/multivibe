# Native inference development

`npm run dev` builds the Rust edge and starts it alongside the TypeScript
control plane. Node watches control-plane sources; restart the command after
Rust changes. `npm start` uses the same supervisor with compiled Node files
(run `npm run build` first). Both commands require Cargo and Node.

The public API listens on `V1_EDGE_PORT` (default 1455). The control plane
listens on loopback at `CONTROL_PLANE_PORT` (default 1456). The supervisor
generates one shared internal credential and stops both children when either
exits. Docker and packaged Host installations use their existing supervisors.

The control plane binding is intentionally not operator-configurable away from
loopback: it is an internal dependency, and the edge on `V1_EDGE_PORT` already
serves and authenticates every dashboard route by reverse proxying to it. To
reach the dashboard from another machine, use `http://<host>:1455` and set
`ADMIN_TOKEN`; do not publish `CONTROL_PLANE_PORT`.

Public Responses, Chat Completions, realtime, WebSockets and inference jobs
belong to Rust. There is no JavaScript inference launch mode. Node retains
admin business logic and the authenticated internal AI SDK adapter. The legacy
TypeScript public proxy has been removed; Node cannot fall back to JavaScript
inference if the native edge is unavailable.

The edge keeps the last successful model list of every remote provider
account in `v1-edge-models-cache.json` beside the account store (override with
`V1_EDGE_MODELS_CACHE_PATH`). A restart therefore serves the models a client
already knows instead of an empty provider list, and the due refresh runs
behind the response. Local runtimes are excluded: their models already come
from the store and are detected on this machine. `GET /v1/models?refresh=true`
still forces a discovery round.

The Chat Completions bridge supports function tools. Unsupported tool dialects
receive `unsupported_tool_contract` rather than being silently discarded.
Custom tools need an explicit adapter before they can be used on this bridge.
