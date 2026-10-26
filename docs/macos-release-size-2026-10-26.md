# macOS release size investigation — 2026-10-26

Measured the actual GitHub v0.2.133 DMGs with 7-Zip 23.01 (HFS+ file inventory).
All sizes below are decimal bytes, excluding alternate streams and directories.
The Apple Silicon DMG SHA-256 matches the published SHA256SUMS:
`87e6648b769cc4bcd08cc0ba30d67f2108295c4261f0e74d3fb3725ffed9c723`.
Its verification record identifies source commit
`1c1d22e3ac7c57ea3625285cb80588aff48a6bf6`.

| Component | Apple Silicon bytes | Intel bytes |
| --- | ---: | ---: |
| Ollama runtime | 545,308,739 | 545,919,811 |
| Chromium Embedded Framework | 340,483,731 | 355,054,245 |
| Node.js executable | 112,937,728 | 115,440,320 |
| Application JavaScript, web assets, dependencies, native addon | 83,677,426 | 83,730,466 |
| Everything else | 48,134,504 | 51,180,034 |
| **Application total** | **1,130,542,128** | **1,151,324,876** |
| HFS+ allocation for application files | 1,153,855,488 | 1,174,622,208 |
| Compressed DMG | 394,180,210 | 409,274,286 |

The previous v0.2.121 Apple Silicon application contains 785,039,069 bytes.
The increase is 345,503,059 bytes (+44.0%), primarily the newly embedded CEF
framework (340,483,731 bytes) and its helper (904,892 bytes).
The Ollama and Node runtime sizes are unchanged between these two releases.

## Largest contributors

Ollama includes `mlx_metal_v3` (190,108,986 bytes) and `mlx_metal_v4`
(208,605,194 bytes). Their two `mlx.metallib` files alone occupy 318,216,560
bytes. Six universal Mach-O executables/libraries also contain 65,698,464
bytes of Intel architecture slices in the Apple Silicon bundle, before
alignment/signature overhead. Removing a backend requires checking its
compatibility contract; these variants are not established as interchangeable.

CEF includes a 236,700,736-byte engine binary plus browser resources and GPU
libraries. `cef-runtime.mjs` copies the release framework, not the whole SDK.

The application dependency tree contains about 33.7 MB of Sentry, 15.7 MB of
OpenTelemetry, and 12.4 MB of better-sqlite3 (including a 9.5 MB SQLite C source
file). These explain secondary opportunities, not the bulk of the package.

## Scope of the measurement

The user reports 1.45 GB for the application in Finder. Neither published DMG
contains an application that large: their logical contents are 1.13–1.15 GB.
The size of that installed copy has not been measured directly, so its
remaining difference is unresolved. No downloaded model weights were found
in the inspected application inventory. A separate managed-runtime copy can
be made outside the application by the provider agent; it cannot explain the
Finder size of the application bundle itself.

Removing local inference eliminates the 545 MB bundled Ollama runtime and
some additional inference helpers/resources. Before those additional removals,
the application would contain approximately 585 MB (Apple Silicon) or 605 MB
(Intel). These are estimates from the published inventory, not rebuilt results.
