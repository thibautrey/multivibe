---
name: Bug report
about: Create a report to help us improve
title: ''
labels: ''
assignees: ''

---

## Describe the bug

A clear and concise description of what is happening.

## Expected behavior

What did you expect MultiVibe to do instead?

## Steps to reproduce

Please provide the smallest reproducible sequence possible.

1.
2.
3.
4.

If the issue involves an API request, include a minimal example with all secrets removed.

```bash
# Example
curl ...
```

## MultiVibe environment

**MultiVibe version / release:**

<!-- e.g. v1.2.3, `latest`, or commit SHA -->

**Installation method:**

* [ ] macOS Host
* [ ] Linux Host
* [ ] Windows Host
* [ ] Docker Compose
* [ ] Unraid
* [ ] Built from source
* [ ] Other

**Operating system:**

<!-- e.g. macOS 26.0, Ubuntu 24.04, Windows 11 -->

**CPU architecture:**

<!-- e.g. Apple Silicon arm64, Intel/AMD x86_64 -->

**GPU, if relevant:**

<!-- e.g. Apple M4 Max, NVIDIA RTX 4090, none -->

## Affected component

Check all that apply:

* [ ] Dashboard
* [ ] MultiVibe Host
* [ ] OpenAI-compatible API
* [ ] Anthropic Messages API
* [ ] Responses API
* [ ] Realtime / WebRTC
* [ ] WebSocket
* [ ] Provider authentication / onboarding
* [ ] Provider routing
* [ ] Model discovery
* [ ] Smart aliases / model policies
* [ ] Quota tracking / failover
* [ ] Local model runtime
* [ ] Deferred jobs
* [ ] Plugins
* [ ] Docker / deployment
* [ ] Automatic updates
* [ ] Other

## Provider

If the issue is provider-specific:

**Provider:**

<!-- e.g. OpenAI / ChatGPT, Anthropic-compatible provider, Mistral, z.ai, Grok, OpenCode, local model -->

**Authentication method:**

<!-- e.g. OAuth, API key. DO NOT include the credential itself. -->

**Model:**

<!-- Exact model name requested, if relevant -->

**Does the issue affect other providers/models?**

<!-- Yes / No / Not tested -->

## Client

If MultiVibe is being accessed by another application:

**Client/application:**

<!-- e.g. Codex CLI, Claude Code, OpenAI SDK, custom application -->

**Client version:**

**Endpoint used:**

<!-- e.g. /v1/responses, /v1/chat/completions, /v1/models -->

## Logs / error output

Paste the relevant error message or a short section of logs.

```text
Paste logs here
```

<!--
Please remove:
- API keys
- Authorization headers
- OAuth tokens
- Cookies
- Provider credentials
- Personal data
- Any other secrets

For Docker installations, relevant logs can usually be obtained with:

docker compose logs --tail=200 multivibe
-->

## Health information

If the Host is running, please include the output of:

```bash
curl -s http://localhost:1455/health
```

```json
Paste output here
```

<!-- Remove anything you consider sensitive before posting. -->

## Screenshots

If applicable, add screenshots or screen recordings that demonstrate the problem.

## Browser

Only complete this section if the problem affects the dashboard.

**Browser:**

<!-- e.g. Chrome 152, Safari 26, Firefox 145 -->

**Browser extensions that may affect the page:**

<!-- Optional -->

## Additional context

Anything else that could help reproduce or diagnose the problem.

Examples:

* Did this work in a previous MultiVibe version?
* Did it start after an update?
* Is the problem intermittent or consistent?
* Does restarting the Host temporarily fix it?
* Does it happen with multiple accounts/providers?
* Is MultiVibe behind a reverse proxy?
* Is the deployment remote or localhost-only?
