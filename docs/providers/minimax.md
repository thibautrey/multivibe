# MiniMax

In Accounts, choose **MiniMax** for a pay-as-you-go API key, or **MiniMax Token Plan** for a Subscription Key. Only the Token Plan connection polls subscription quota; ordinary API keys are not repeatedly probed against a subscription service.

Requests use MiniMax's official OpenAI-compatible endpoint at `https://api.minimax.io/v1`. Client model IDs are prefixed with `minimax/` or `minimax-coding/`; for example, select `minimax-coding/MiniMax-M3`. MultiVibe removes that provider prefix before sending the request.

The bundled text catalog follows MiniMax's [OpenAI SDK documentation](https://platform.minimax.io/docs/api-reference/text-openai-api): MiniMax-M3 and the documented M2.x variants. MiniMax-M3 has a 1,000,000-token context window and supports image input through the OpenAI-compatible API; the listed M2.x models have 204,800-token context windows. Model availability can change, and custom model IDs may be entered manually.

For Subscription Keys, MultiVibe reads the 5-hour and weekly quota windows from MiniMax's documented bearer-authenticated [`token_plan/remains` endpoint](https://platform.minimax.io/docs/token-plan/faq#how-to-check-token-plan-usage). MiniMax's public documentation gives the request but does not publish a response schema. The parser is therefore limited to fields demonstrated by public CodexBar fixtures (`model_remains`, remaining percentages, and reset timestamps), and reports unfamiliar payloads as errors instead of guessing.
