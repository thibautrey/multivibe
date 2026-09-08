# Public plugin registry

The landing reads `catalog/plugins.json` from the public `main` branch at runtime,
then reads `multivibe.module.json` at each registered repository/ref. Add a reviewed
public, installable plugin here to publish it without rebuilding the landing.
Manifest name, description, version, categories and author refresh automatically.
Only register repositories that pass Core's plugin submission validation. This is
an editorial public directory, not a list of a user's installed plugins. Entries
are not automatically installed or enabled. Remove an entry to unlist it.

Contract: `schemaVersion: 1`, `plugins: [{ repository, ref }]`; repository must be
an HTTPS GitHub owner/repository URL and ref a branch, tag or commit. Clients
refresh every five minutes while visible. GitHub CDN caching can add propagation
delay. The landing deployment and this registry must be published once before
runtime updates work. No credentials are needed or exposed.
