# Verified Apple Host (experimental, disabled)

This Apache-2.0 source implements a separate `apple_host_verified` native runtime. It does not change the ordinary MultiVibe Host or grant it a verified tier. The existing repository LICENSE and NOTICE apply. Anyone can inspect, build and modify this code; running a modified build does not make it an approved release.

**This is not a TEE or Apple Private Cloud Compute.** Prompts exist in ordinary process and GPU memory while MLX executes. SIP, Secure Boot, signing and debugger restrictions reduce attack opportunities; they do not prove that an administrator or a compromised OS cannot obtain plaintext. APNs confirms delivery to an app identity, not the exact executable contents. Secure Enclave protects a signing key; it does not run the model. Swift/MLX memory is not guaranteed to be zeroized. Local model hashes also cannot defeat an administrator changing memory or files during execution.

## What the code does

- `Sources/AppleVerifiedCore/Envelope.swift`: authenticates and decrypts X25519/HKDF-SHA256/AES-256-GCM request envelopes, binds model digest, release, host, connection and expiry, rejects replays, and encrypts each response using a separately derived key. `modelDigest` is mandatory. Requests expire within 60 seconds and never outlive the admitted lease.
- `Sources/AppleVerifiedCore/AppleChallenge.swift`: owns the process X25519 key, decrypts the APNs challenge and signs its exact transcript with a device-bound Secure Enclave P-256 key. Admission compares the full binding and accepts at most a five-minute lease.
- `Sources/MultiVibeVerifiedHost/App.swift`: receives challenges exclusively through the native APNs callback and returns proof over the same outbound TLS WebSocket. The receive loop continues during generation; revocation, disconnect, protocol error or rejection cancels generation, closes the key/session and exits. Cancellation of GPU work is cooperative, and memory zeroization is not guaranteed. There is no local plaintext inference HTTP port.
- `Sources/MultiVibeVerifiedHost/MLXRuntime.swift`: verifies an explicit model file manifest before and after loading, then runs a bounded text-only request inside this process through pinned MLX Swift dependencies. It cannot invoke tools or external model servers.
- `Sources/CHardening/Hardening.c`: denies debugger attachment, rejects an already traced process, disables core dumps, and discards stdout/stderr before inference to prevent dependency output from logging prompts.

## External qualification is required

The checked-in configuration is disabled. Building or signing this app is insufficient to activate verified service. Production needs a reviewed, signed and notarized arm64 application; an APNs-enabled app identity and provisioning profile; protected enrollment credentials; a trusted MDM connector that obtains recent SIP and Full Secure Boot state; and independently verified Apple Managed Device Attestation binding the enrolled device to the **same** Secure Enclave public key and fresh challenge. The runtime's local Keychain key creation is not that attestation ceremony. If the deployment cannot establish the exact key binding, admission must fail.

The backend must independently approve the release and model digests, supply the enrolled APNs token through its trusted enrollment path, send the encrypted challenge using Apple credentials, and revoke the lease immediately when the original live connection closes. Do not treat any client-supplied status, APNs token, model digest or release digest as external evidence. Those connectors and physical-device qualification must be completed before this tier can be offered.

## Session adapter contract

The app connects to `/v1/apple-host/connect` with subprotocol `multivibe-apple-host-session-v1`. Each JSON message is `{type,payload}`. Server `hello` supplies `hostId,sessionId`; app returns `binding`. Native APNs receives the encrypted challenge under the `multivibe` key and returns `challenge_response` with `hostId,sessionId,challengeId,signature,challengeDigest`. Signature is DER P-256, standard base64. The backend sends `lease`, then `request` and receives `response`; `revoke` closes the process. `apns_registration` is informational only and must not replace trusted enrollment. The app reads its connection bearer from the login Keychain service `com.multivibe.apple-verified.connection`, account hostId.

Challenge protocol is `multivibe-apple-host-verification-v1`; keys are DER SPKI standard base64. Inference protocol is `mvah-inference-v1`; ephemeral keys are raw 32-byte base64url. Request AAD is sorted-key JSON excluding ciphertext/tag. HKDF salt is SHA256(request AAD); request and response info strings are `multivibe/apple-host/request/v1` and `multivibe/apple-host/response/v1`. Response AAD is its own sorted metadata excluding ciphertext/tag. No streaming plaintext is sent through Cloud.

## Building and validation

Use macOS 14+ and Apple Silicon. Run `swift build -c release --package-path host/apple-verified` and `swift test --package-path host/apple-verified` from the integrated main checkout. Direct dependency versions are exact; review and preserve the resolved transitive dependency graph with the release. Copy the executable, model manifest and disabled runtime configuration into a proper `.app`, include the provision profile and sign with hardened runtime and `packaging/entitlements.plist`; notarize through the release process. `scripts/validate-bundle.sh path/to/app` checks the signature, entitlement allowlist and disabled default. The sandbox requires deployment-specific permission for the model directory; granting broad filesystem entitlements needs separate review.

`scripts/check-core.sh` typechecks the dependency-free CryptoKit core and C hardening without resolving MLX. XCTest covers encrypted round trip, separated response keys, replay, closed sessions and malformed encoding. These checks are not a signed-build, APNs, MDM/MDA or real-GPU end-to-end proof.
