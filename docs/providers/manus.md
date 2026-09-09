# Manus

Choose **Manus**, enter a Manus API key, and select `manus/standard`, `manus/lite`, or `manus/max`. Manus is an asynchronous agent service, not an OpenAI-compatible model endpoint. The adapter uses the documented [v2 task API](https://open.manus.ai/docs/v2/task.create).

Each completion creates a private task from the text conversation transcript, with no connectors requested. The adapter polls task events and returns the latest assistant result. A waiting task returns its question and a link to continue in Manus; actions are never automatically confirmed. Conversations do not resume an earlier Manus task through a new completion. Client tool calls, images, sampling controls, token limits and structured-output controls are rejected before task creation.

Streaming requests buffer the task result and then deliver normal SSE frames; Manus does not emit model token counts, so none are estimated. Requests are bounded to 175 seconds. On cancellation or failure the adapter attempts to stop the created task with a separate five-second timeout. Network failures can prevent cleanup; the task remains visible in the Manus application. No authenticated task was created during development.

[Available credits](https://open.manus.ai/docs/v2/usage.availableCredits) refresh through the same API key. The authoritative `total_credits` balance is displayed separately from the subscription allowance, because add-on credits can fund tasks after subscription credits are consumed. Periodic quota percentages use only an explicit `pro_monthly_credits` denominator and provider period end. Daily or weekly refresh grants are not mistaken for a hard rolling inference limit.
