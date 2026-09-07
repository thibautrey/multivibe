# Ordinary Host security boundary

Cloud is trusted and may process prompts. Ordinary Mac and NVIDIA hosts run plaintext inference: their administrators can access prompts, responses and intermediate RAM/VRAM. Neither signed jobs nor a private working directory prevents this.

Managed execution keeps the existing Cloud signatures, session controls, loopback runtime endpoint, explicit child environment, private storage and pinned runtime/model profiles. This change removes raw Ollama stdout/stderr persistence and strips unnecessary top-level identity/cache metadata before execution of reviewed profiles. It does not remove secrets from message content or erase historical logs.

Reviewed chat requests accept inline images, but reject image URLs that would let the runtime fetch remote or local resources. Integrators must provide inline images through a trusted retrieval path. Text and streaming retain their existing model semantics. Raw runtime diagnostics are no longer available on disk; structured lifecycle state remains available.

This is process-level separation, not a complete operating-system sandbox. Dedicated service identities, OS-specific network/filesystem isolation, crash-dump policy and descendant-process containment still require implementation and platform qualification. No claim of zero memory retention or global zero logging is made. Model caches, the operator's software and Cloud queues have separate lifetimes.

Qualified confidential hosts are a separate future pool requiring verified hardware protection and attestation of the full CPU/GPU inference path. Ordinary hosts never satisfy that policy by declaration. Cloud stays an orchestrator; no FHE/MPC or new confidential runtime is enabled here.

The detailed two-pool decision, data flow, limitations and acceptance criteria are in the Cloud repository's `docs/ordinary-and-confidential-host-security.md`.
