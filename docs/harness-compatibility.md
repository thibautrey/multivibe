# Harness compatibility

MultiVibe Host detects coding agents without executing them. A detected harness is classified as either:

- **Automatic**: MultiVibe can write documented, per-user OpenAI-compatible configuration and restore the exact previous files.
- **Manual**: the harness is detected, but its configuration is project-local, spans multiple files, uses a proprietary protocol, or cannot yet be merged safely.

Detection is not a claim that a real task has completed through that harness. Automatic integrations still require a reachable MultiVibe Host model and are covered by configuration tests.

## OpenAI Codex

MultiVibe configures an authenticated `multivibe` Responses API provider and `model_catalog_json` at the user level in `~/.codex/config.toml`, and maintains the discovered catalog in `~/.codex/multivibe-models.json`. The provider's `experimental_bearer_token` supplies the managed proxy API key; redirecting the built-in `openai` provider with `openai_base_url` alone instead sends OpenAI credentials and fails proxy authentication. The config is written with owner-only permissions. While Host is running, it polls the authoritative MultiVibe catalog and atomically refreshes this managed file when providers or models change; clients that watch `config.toml` also receive a reload event, while the documented fallback remains starting a new Codex process. Existing OpenAI login files are preserved. “Repair connection” migrates the URL-only configuration to the authenticated provider, refreshes the catalog, and keeps exact restore metadata for disconnect. After updating Host, repair the Codex connection and restart Codex to apply the credentials. The generated catalog preserves Codex-native model capabilities returned by Host, including image input support; synthetic fallback entries are used only for models that do not publish native Codex metadata.

## September 2026 expansion

The registry expansion below was checked against upstream project documentation on 2026-09-10.

| Harness | Integration | Upstream evidence |
| --- | --- | --- |
| mini-SWE-agent | Automatic | [Global `.env`, model and key configuration](https://mini-swe-agent.com/latest/advanced/global_configuration/) |
| gptme | Automatic | [Named OpenAI-compatible providers in `~/.config/gptme/config.toml`](https://github.com/gptme/gptme/blob/master/docs/providers-custom.rst) |
| ShellGPT | Automatic | [Runtime configuration and `API_BASE_URL`](https://github.com/TheR1D/shell_gpt#runtime-configuration-file) |
| Mistral Vibe | Manual | [CLI and `~/.vibe` configuration](https://github.com/mistralai/mistral-vibe) |
| AIChat | Manual | [OpenAI-compatible clients and agents](https://github.com/sigoden/aichat) |
| Kimi Code CLI | Manual | [OpenAI-compatible provider configuration](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/providers.md) |
| Pochi | Manual | [Open-source IDE agent and BYOM support](https://github.com/TabbyML/pochi) |
| Tabby | Manual | [Self-hosted coding assistant and IDE extensions](https://github.com/TabbyML/tabby) |
| GPTScript | Manual | [LLM workflow framework](https://github.com/gptscript-ai/gptscript) |
| Fabric | Manual | [CLI AI framework](https://github.com/danielmiessler/Fabric) |
| Zed Agent Panel | Manual | [Agent Panel documentation](https://zed.dev/docs/ai/agent-panel) |
| JetBrains Junie | Manual | [Junie coding agent](https://www.jetbrains.com/junie/) |
| Amazon Q Developer CLI | Manual | [Amazon Q CLI](https://github.com/aws/amazon-q-developer-cli) |
| Sourcegraph Cody | Manual | [Cody](https://sourcegraph.com/cody) |
| Trae | Manual | [Trae](https://www.trae.ai/) |
| Qoder | Manual | [Qoder](https://qoder.com/) |
| CodeRabbit CLI | Manual/project | [CodeRabbit CLI](https://www.coderabbit.ai/cli) |
| Qodo Merge / PR-Agent | Manual/project | [PR-Agent](https://github.com/qodo-ai/pr-agent) |
| GPT Engineer | Manual/project | [GPT Engineer](https://github.com/AntonOsika/gpt-engineer) |
| AiderDesk | Manual | [AiderDesk](https://github.com/hotovo/aider-desk) |
| PearAI | Manual | [PearAI](https://github.com/trypear/pearai-master) |
| Devika | Manual/project | [Devika](https://github.com/stitionai/devika) |
| smol developer | Manual/project | [smol developer](https://github.com/smol-ai/developer) |
| SWE-smith | Manual/project | [SWE-smith](https://github.com/SWE-bench/SWE-smith) |
| SWE-ReX | Manual/project | [SWE-ReX](https://github.com/SWE-agent/SWE-ReX) |
| Agentless | Manual/project | [Agentless](https://github.com/OpenAutoCoder/Agentless) |

Tools that are discontinued or superseded are not added merely to increase the count. For example, Void is deprecated and Mods was archived in favor of Crush. Browser-only services without a reliable local executable or footprint are also excluded because Host cannot detect them truthfully.
