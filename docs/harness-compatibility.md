# Harness compatibility

MultiVibe Host detects coding agents without executing them. A detected harness is classified as either:

- **Automatic**: MultiVibe can write one documented, per-user OpenAI-compatible configuration and restore the exact previous file.
- **Manual**: the harness is detected, but its configuration is project-local, spans multiple files, uses a proprietary protocol, or cannot yet be merged safely.

Detection is not a claim that a real task has completed through that harness. Automatic integrations still require a reachable MultiVibe Host model and are covered by configuration tests.

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
