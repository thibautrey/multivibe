# Distribution validation — 2026-09-07

## Worktree checks

- Dependency-free Node release/package tests passed before integration.
- Homebrew Ruby syntax and Bash publisher syntax passed.
- `git diff --check` passed.
- No dependency installation or native builds were attempted in the worktree.

## Validation from local main

- 27 Node tests passed across the distribution, provider archive, container,
  update-packaging and signed update-feed suites. Registry publication tests use
  simulated registries to prove failure handling, immutable version protection,
  digest preservation flags and prevention of `latest` rollback.
- Docker Compose configuration validation passed for CasaOS/ZimaOS and the
  TrueNAS custom Compose package (with explicit example inputs for TrueNAS).
- The TrueNAS catalog template rendered against the actual upstream 2.3.11
  library from truenas/apps commit
  `559f8b652f69c2fc838a246ac00c14eb91ebff6e` in an isolated temporary environment.
  Assertions passed for GPU reservations, port/storage mappings, read-only
  filesystem, retained image healthcheck and restricted capabilities. Invalid
  GPU selection and identical data/model directories were rejected.
- All three generated WinGet manifests passed Microsoft's official 1.6.0 JSON
  schemas. This checks manifest structure, not live installer availability.
- PowerShell 7.6.5 parsed all four packaging scripts successfully.
- Actionlint 1.7.12 passed for both new workflows and the edited release workflow
  (shellcheck and pyflakes integrations disabled).

The initial TrueNAS import lacked the Docker Python package; it was installed in
an isolated temporary validation venv from main. No project lockfiles changed.
The host's installed GitHub CLI reports `unknown command "attestation"`;
production attestation checks are implemented for the modern GitHub-hosted CLI.

## Still required before publishing/claiming compatibility

- Homebrew audit and install/uninstall/update on both supported Mac architectures.
- Real TrueNAS and CasaOS/ZimaOS NVIDIA setup, inference and update/persistence tests.
- Inno compilation and the Windows wrapper smoke test on a Windows runner, plus
  the complete native install/upgrade/uninstall on supported NVIDIA hardware.
  The Windows CI job is implemented but has not run from this local checkout.
- A trusted Windows code-signing identity, Authenticode/timestamp verification,
  signed installer release and WinGet validation against the real published EXE.
- Docker Hub account/repository configuration, an actual publish and anonymous pull.
- Publication of the Homebrew tap and upstream catalog/WinGet submissions.
- Umbrel remains blocked by the upstream amd64+arm64 requirement and an unverified
  NVIDIA integration; no compatible package is advertised.

No new channel was submitted, no container was deployed, and no repository was
pushed during this implementation task.
