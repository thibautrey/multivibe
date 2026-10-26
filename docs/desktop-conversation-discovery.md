# Conversations from connected environments

Desktop automatically lists supervised Host sessions and native CLI histories from every registered environment, including conversations created outside MultiVibe. Each entry retains its harness and environment. Catalogs refresh while the chat window is open; the selected native or server conversation refreshes independently. An offline environment preserves cached messages and drafts and shows a synchronization error.

Supported native history readers: Hermes, Pi, Codex, Claude Code, OpenCode and Gemini CLI. LibreChat and Open WebUI retain their existing account-bound server synchronization. SSH and bridged containers query the Host inside that environment; an unbridged container never reads the Mac's histories.

Listing and reading never start a harness or acquire an existing CLI process. Replying to a native history uses the adapter's existing isolated fork support (Pi, Codex, Claude Code and OpenCode). Hermes and Gemini histories remain readable; their adapters do not advertise isolated continuation. Server conversations continue in their existing server chat.

Native discovery scans at most 5,000 entries and returns up to 500 sessions per harness, visiting date-based directories newest first. Native message reads are bounded to 16 MiB and 20,000 records. Missing entries in a bounded scan do not delete cached history. Deleting a discovered CLI entry hides it on this Desktop without deleting the original native history. The session inspector remains available for explicit import and raw metadata inspection.
