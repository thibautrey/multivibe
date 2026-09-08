# Cloud network model policies

Cloud owns model selectors under `multivibe/`. Core forwards these names intact
through the MultiVibe Cloud account, without local alias or image-model rewrites.

- `multivibe/<model>` chooses ordinary community workers.
- `multivibe/secured_preferred/<model>` prefers qualified protected execution,
  permitting ordinary execution when that pool has no eligible capacity.
- `multivibe/secured_guaranteed/<model>` fails if no qualified secured worker is
  available. Cloud must not forward it to an ordinary worker.

Use full publisher/model IDs when short names are ambiguous. Existing managed
provider names remain valid. Future policy dimensions such as green are owned
by Cloud's explicit policy registry; Core does not strip or reinterpret them.
Unknown policies are rejected by Cloud until their evidence rules are implemented.

These model names protect against the worker operator, with Cloud trusted to
process content. They do not replace Core's stronger `confidential_verified`
client-to-runtime encryption setting. Production secured capacity remains
unavailable until actual hardware/runtime qualification and trusted bindings.

The cryptographic client now exposes prompt-free `prepare`, returning a
single-use session that rechecks evidence freshness before execution. Cloud
vendors this Apache-2.0 client for its attested worker transport; keep both copies
identical when updating the protocol. No trust roots or hardware are bundled.
