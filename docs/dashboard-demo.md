# Dashboard demo and screenshots

The demo uses the current React dashboard, with a Vite middleware serving fictional
API responses. It is a separate development instance, not a switch on a running gateway.

## Start

From the repository root, with Node.js 22+:

```sh
npm --prefix web ci
npm run demo
```

Open <http://localhost:4173>. The server binds to loopback and fails if port 4173
is occupied, so it cannot silently replace another instance. Stop it with Ctrl+C.
For a remote development host, forward port 4173 over SSH before opening it locally.

No backend, provider credentials, GPU runtime, or stored accounts are required.
`?sanitized=1` only masks real data on a normal installation; it does not enable
the demo. The mock API is enabled only by `vite --mode demo`, never by a production
build or the normal `npm run dev` command.

## Sample data and supported interactions

- Four fictional accounts: two OpenAI accounts, a Mistral account, and local Ollama.
- Five provider models and three routing aliases.
- Five application key previews, with no usable secrets.
- Two weeks of seeded requests, including cache usage, errors, timings, and projects.
- Home, Providers, Routing, Activity, API access, API workspace, and Extensions views.
- Working model filters, time ranges, request pagination, and expandable trace details.

The request statistics and project totals use the application's existing aggregation
functions, so the charts reconcile with the underlying records. Fixture timestamps
are relative to server startup and remain stable until restart.

This is a read-only preview. Writes, provider connections, inference, and exports
return explicit errors. Automatic discovery and quota-refresh requests return
fixtures without contacting anything. Host updates are unavailable because this
is not a native Host installation.

## Capture the current UI

1. Start the demo from the commit being documented.
2. Use the normal desktop browser viewport and select the light theme in the sidebar.
3. Keep the **Demo data** badge and fictional-data notice visible.
4. Capture the viewport after fonts and charts finish rendering. Do not reuse screenshots
   from older releases or capture an authenticated production instance.
5. Save captures under `assets/screenshots/` and update the README references together.

Useful routes:

| Screen | URL |
| --- | --- |
| Home | <http://localhost:4173/?tab=overview> |
| Providers | <http://localhost:4173/?tab=accounts> |
| Routing | <http://localhost:4173/?tab=aliases> |
| Activity | <http://localhost:4173/?tab=tracing> |
| API workspace | <http://localhost:4173/?tab=docs> |

Fixtures live in `web/demo/fixtures.ts`; the read-only API is in `web/demo/api.ts`.
Update their typed shapes alongside future API changes.
