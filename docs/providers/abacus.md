# Abacus.AI

Choose **Abacus.AI** and enter the RouteLLM API key from ChatLLM. The fixed self-service endpoint is `https://routellm.abacus.ai/v1`; chat completions, streaming and client tool calls use the existing compatible adapter. `abacus/route-llm` selects Abacus's router; the starter catalog also includes documented explicit model IDs.

[RouteLLM documentation](https://abacus.ai/help/developer-platform/route-llm/) describes subscription credit accounting and continued RouteLLM access after the monthly allowance is consumed. Its public API documentation does not expose a credit-balance query with the inference key.

[CodexBar's quota integration](https://github.com/steipete/CodexBar/blob/main/docs/abacus.md) requires separate browser session cookies for `_getOrganizationComputePoints` and `_getBillingInfo`. MultiVibe does not collect those cookies. The connection clearly reports that subscription balances cannot be fetched with its RouteLLM key; request token usage remains tracked. Enterprise workspace endpoints can use the existing custom compatible connection.
