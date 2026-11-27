# Repository rules for contributors and coding agents

These rules apply to every change in this repository, whether written by a
person or by an AI agent. They exist because MultiVibe is open source software:
it must install and make sense for anyone, anywhere. Nothing in the tree may
describe, assume or leak one specific operator's home lab.

If another instruction, template, comment or habit conflicts with this file, this
file wins. Reviewers should block a pull request that violates it.

## 1. English everywhere

- `README.md`, `docs/`, `packaging/`, `release-notes/`, `.github/` templates,
  code comments, commit messages and test names are written in English.
- Never leave non-English prose in a tracked document, even in a single section,
  heading or table cell.
- Product localization is different: translated UI catalogs live under
  `packages/ui/src/i18n/<locale>/` and are expected to be translated. A UI label
  quoted in an English document is quoted in English, not verbatim in another
  language.
- A localization guide may show translated strings as data, but its prose stays
  English.

## 2. Never reference private or operator-specific infrastructure

Never hardcode, document or commit:

- private/LAN IP addresses, home DNS names, VPN host names, SSH aliases;
- personal email addresses, account identifiers, usernames, home directories;
- internal machine names (a NAS, a tower, a VM, a build box, a runner);
- internal service names, internal repositories or non-public deployments;
- an endpoint, port or default that only works on one private network;
- wording that assumes the reader is the maintainer: "our machines",
  "our infrastructure", "our host", "chez nous".

If a feature needs a private endpoint, read it from configuration **with no
bundled default, or with a public/unroutable placeholder default**, and document
it generically.

## 3. Use neutral, non-identifying examples

| Kind | Use |
| --- | --- |
| IPv4 examples in docs | `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` (RFC 5737), `127.0.0.1` |
| Hosts and URLs | `example.com`, `example.org`, `host.example.invalid` |
| Paths | `/srv/multivibe`, `/data`, or paths relative to the repository |
| User paths in tests | `/Users/provider`, `/Users/test`, `/Users/demo`, `/Users/example`, `/home/provider`, `/home/client`, `/home/runner` |
| Credentials in fixtures | obviously fake values: `test-key`, `user@example.com`, `secret` |

Test fixtures that must exercise private-network logic may use RFC 1918
addresses, but pick an arbitrary range: never reuse the maintainer's actual
subnet or a host that exists on it.

## 4. Operator data lives outside the repository

- Per-machine host names, IPs, tokens and procedures belong in the git-ignored
  local file `DEPLOY.local.md` or in another local untracked override. Never
  commit them.
- The committed `docker-compose.yml` stays generic. Operator values go in an
  untracked `docker-compose.override.yml` or environment variables.
- Never commit `.env` files, credentials, private keys, exported runtime state,
  database dumps, or logs containing request data.

## 5. Platforms are welcome, personal setups are not

- It is fine to support and document Unraid, Umbrel, TrueNAS, CasaOS, Docker,
  Homebrew and similar platforms.
- Packaging for a platform uses that platform's **standard** paths and
  instructions, so that any user can follow them.
- A template, compose file or generator must never embed one operator's
  configuration, hostname, filesystem layout or credentials.
- A provider adapter must not ship a private default endpoint. Third-party
  integrations are configured by the user.

## 6. Never commit local machine or editor state

`xcuserdata/`, `*.xcuserstate`, `.DS_Store`, `.idea/`, `.vscode/`, editor
workspace files, local caches, build output and personal dotfiles stay out of
the tree.

## 7. Run this check before every commit

From the repository root:

```sh
# Personal paths, usernames and emails (public repository URLs are fine).
git grep -nE '/(Users|home)/[A-Za-z0-9._-]+|@gmail\.com|@proton\.me' \
  -- ':!DEPLOY.local.md' ':!AGENTS.md' ':!*LICENSES.txt' \
  | grep -vE '/(Users/(provider|test|demo|example)|home/(provider|client|runner|example))'

# Internal machine names.
git grep -niE 'codex-unraid|\bTower\b' -- ':!DEPLOY.local.md'

# Maintainer-centric wording.
git grep -niE '\bour (machines?|infrastructure|servers?|nas)\b|notre infra' \
  -- ':!DEPLOY.local.md' ':!AGENTS.md'

# Non-English prose in documentation.
git grep -nE '[àâäéèêëîïôöùûüçŒœ]' -- '*.md' \
  ':!AGENTS.md' ':!packages/ui/src/i18n/GUIDE.md' \
  ':!packaging/macos/face-recognition/NOTICE.md'
```

Every command must print nothing. If a legitimate exception is unavoidable, the
change must explain it in the commit message and narrow the check here at the
same time — never silently widen the allow-list.

## 8. Applies to changes, not just to the current tree

- Do not reintroduce the patterns above in a new file, a new fixture, a new doc
  section, a CI workflow, a packaging template or a test.
- Do not add personal data in code that is later copied into documentation.
- When removing such data, remove it from defaults, examples, tests, fixtures
  and generated metadata together.
