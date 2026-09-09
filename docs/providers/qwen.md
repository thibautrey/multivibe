# Alibaba ModelStudio Coding Plan

MultiVibe connects to Alibaba ModelStudio's Coding Plan through its dedicated OpenAI-compatible endpoint. This is a fixed-price developer subscription and is distinct from the standard pay-as-you-go DashScope API.

## Endpoint and authentication

Use a Coding Plan-specific API key, whose documented prefix is `sk-sp-`. The registered provider uses the international endpoint:

`https://coding-intl.dashscope.aliyuncs.com/v1`

The China (Beijing) endpoint is `https://coding.dashscope.aliyuncs.com/v1`. Keys and service availability are region-specific. A standard DashScope key and endpoint charge pay-as-you-go usage instead of consuming Coding Plan quota.

## Models

Alibaba's current exact model list includes Qwen, GLM, Kimi, and MiniMax models. The built-in catalog mirrors the list published by Alibaba and the official Qwen Code client as of September 9, 2026. Alibaba may change this lineup, so the authenticated model-list endpoint remains authoritative for a particular subscription.

## Quota

Alibaba documents rolling five-hour, weekly, and subscription-month quotas. MultiVibe probes the international ModelStudio console RPC `queryCodingPlanInstanceInfoV2` using the configured API key. It maps explicit `per5Hour`, `perWeek`, and `perBillMonth` used/total counters and provider reset timestamps. Multiple subscription instances must identify one active instance; unknown or ambiguous counters are errors.

This RPC is not a stable public Coding Plan API. The request and response contract are reviewed against [CodexBar's public implementation](https://github.com/steipete/CodexBar/blob/main/docs/alibaba-coding-plan.md) and fixtures. Some accounts require console cookies even with a valid inference key. An explicit `ConsoleNeedLogin` response displays that limitation without inventing quotas or blocking inference. Other failures preserve stale readings with an error. No cross-region credential fallback or browser-cookie collection is performed.

## Sources

- [Alibaba Cloud Coding Plan](https://www.alibabacloud.com/help/en/model-studio/coding-plan)
- [Qwen Code authentication and Coding Plan setup](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/)
- [Official Qwen Code Coding Plan preset](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/providers/presets/alibaba-coding-plan.ts)
