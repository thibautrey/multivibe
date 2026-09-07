# Worker / Cloud integration tests

From the repository root:

```sh
go -C provider-agent test -race -run '^TestWorkerCloudIntegration' -count=1 .
```

These tests also run in the existing `npm run test:provider-host` suite. They use
loopback HTTP servers, temporary enrollment/replay state, and ephemeral signing
keys. No Cloud account, GPU, model download, or service credentials are needed.

Coverage:

- Enrollment challenge and signed proof, selected-model declaration in the
  manifest, persisted node identity reused to open the diagnostic session.
- Live runtime catalog discovery, job polling, exact inference payload and
  completion with token counts; unavailable engines and invalid output.
- Community inference claim transport, signed model mapping, JSON completion,
  ordered SSE chunks, engine failures and terminal streaming errors.
- Durable replay protection across reopening the state file, including failed
  executions and partial streams.

Cloud HTTP contracts were checked against the sibling `multivibe-cloud` checkout:
`src/app.ts`, `src/provider-worker-test.ts` and `src/community-outbound-inference.ts`.
The HTTP peers and community execution backend are test doubles. This suite does
not start the Cloud application or Core gateway, exercise PostgreSQL, publish a
commercial inventory, acquire a community session through the control plane, or
prove production routing/earnings eligibility. Enrollment model declaration is
not commercial catalog publication. The diagnostic and community corridors have
separate fixtures because enrollment alone does not authorize community work.
