# Exact method source extracted from Hermes 6d49922875f60af5bc31e2bfbae78a81d2fa91fc (MIT).
# Full source SHA256: 1231ecb560a7eac9b2e0fcda656b3053a5e20f1065d5ddf86be0805b34ea42b9
MINIMUM_CONTEXT_LENGTH = 64_000
class ContextCompressor:
    _MIN_CTX_TRIGGER_RATIO = 0.85
    @staticmethod
    def _effective_input_window(context_length: int, max_tokens: int | None) -> int:
        """Usable input budget: the window minus the output reservation, or the whole window when the reservation
        is unset or leaves nothing."""
        effective_window = context_length - (max_tokens or 0)
        return effective_window if effective_window > 0 else context_length
    @staticmethod
    def _compute_threshold_tokens(
        context_length: int, threshold_percent: float, max_tokens: int | None = None,
    ) -> int:
        """Compute the compaction trigger in tokens from the effective input budget.
        Base is ``(context_length - max_tokens) * threshold_percent`` floored at MINIMUM_CONTEXT_LENGTH;
        when the floor binds it is capped at 85% of the budget so small windows can still fire.

        The base value is ``effective_input_budget * threshold_percent``, floored at
        ``MINIMUM_CONTEXT_LENGTH`` so large-context models don't compress prematurely at 50%. BUT that floor
        degenerates at small windows: for a model whose ``context_length`` is at/below the minimum (e.g. a
        64K local model), ``max(0.5*64000, 64000) == 64000`` makes the threshold equal the ENTIRE window —
        auto-compression can never fire because the provider rejects the request before usage reaches 100%
        (#14690).
        The provider reserves ``max_tokens`` of output space out of the same window, so the usable INPUT
        budget is ``context_length - max_tokens``. With a large ``max_tokens`` (e.g. 65536 on a custom
        provider) the input budget is materially smaller than the raw window, and a threshold based on the
        full window lets the session hit a provider 400 before compaction fires (#43547). The percentage and
        the degenerate-window check below both operate on the effective input budget. ``max_tokens=None``
        (provider default) conservatively assumes no reservation (full window).
        """
        effective_window = ContextCompressor._effective_input_window(context_length, max_tokens)
        pct_value = int(effective_window * threshold_percent)
        floored = max(pct_value, MINIMUM_CONTEXT_LENGTH)
        # The floor must not consume output headroom: cap at 85% when it is the binding term. Near-minimum windows
        # otherwise trigger at ~98%, and providers that silently clip over-window prompts (ollama) never raise the
        # overflow backstop, so the session wedges. An explicit threshold_percent above 85% is user intent; not capped.
        trigger_cap = int(effective_window * ContextCompressor._MIN_CTX_TRIGGER_RATIO)
        if effective_window > 0 and floored > pct_value and floored > trigger_cap:
            floored = max(pct_value, trigger_cap)
        # A percentage at/above the window is unreachable; trigger at 85% instead.
        if effective_window > 0 and floored >= effective_window:
            return max(1, min(trigger_cap, effective_window - 1))
        return floored
