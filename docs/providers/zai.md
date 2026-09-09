# Z.AI GLM Coding Plan

Z.AI's GLM Coding Plan is already supported by MultiVibe's native `zai` connection. Its default inference path uses the dedicated OpenAI Chat Completions base URL:

`https://api.z.ai/api/coding/paas/v4`

Create an Individual or Team Plan key in the Z.AI Coding Plan console. Team Plan keys are not interchangeable with other Z.AI API keys. The general pay-as-you-go GLM endpoint is a separate product and must not be substituted for the coding endpoint.

The provider picker identifies this existing connection as **Z.AI GLM Coding Plan**. Model discovery and the existing quota parser are retained; no duplicate connection is registered.

## Quota

Z.AI's official usage plugin sends the configured coding credential to `GET https://api.z.ai/api/monitor/usage/quota/limit`. MultiVibe's existing Z.AI parser supports the published five-hour `TOKENS_LIMIT` percentage and keeps `TIME_LIMIT` tool allowances separate from model routing. It also accepts explicit five-hour and weekly credit windows when the provider supplies their period metadata.

The official public plugin does not establish the current weekly response shape or reset fields. MultiVibe rejects unknown model periods instead of guessing them. Historical model and tool usage endpoints are optional and are not needed for routing.

## Sources

- [GLM Coding Plan quick start](https://docs.z.ai/devpack/quick-start)
- [GLM Coding Plan overview and model list](https://docs.z.ai/devpack/overview)
- [Official Z.AI usage query plugin](https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs)
