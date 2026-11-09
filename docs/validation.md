> Historical Phase 1 report. It describes an earlier, Windows-only state and is
> superseded by the [current Phase 6 test evidence](test-evidence.md),
> [installation guide](installation.md) and [security limitations](security-limitations.md).

# Validation report ? 2026-11-04

## Current Rust verification (supersedes Phase 1 Rust blockers)

Environment: rustc/cargo 1.99.1, x86_64-pc-windows-msvc; Node.js 22.16.0. CARGO_HOME was set to the workspace .cargo-local. AWS_LC_SYS_PREBUILT_NASM=1 enabled the dependency's supported packaged Windows assembly objects because NASM is not installed.

| Command | Actual result |
|---|---|
| node scripts/cache-rust-dependencies.mjs | Passed; final lockfile contains 263 official registry archives, all SHA-256 verified against registry metadata and Cargo.lock |
| cargo fmt --all -- --check | Passed, exit 0 |
| cargo check -p phoenix-core --all-targets --offline --locked | Passed, exit 0; finished in 13.27s on final check |
| cargo test -p phoenix-core --offline --locked | Passed, exit 0; 16 passed, 0 failed, 0 ignored, 0 filtered out |
| Rust doc-tests | 0 tests; completed successfully |
| Dashboard/backend preservation | All 8 recorded app source, package manifest and JavaScript lockfile hashes unchanged |

Unit suite execution took 0.19s after compilation. All 16 existing tests ran: unknown-agent view, independent sentinel registration, duplicate registration, premature crash, owner reopening, pause, forged heartbeat, unauthorized registration/containment, valid/late heartbeat, forged approval, approval-required recovery, replayed recovery, generation advancement and containment revoking approval. No contract source edits were necessary.

Initial check attempts exposed missing NASM and chrono API incompatibility; the final successful check and test used shipped AWS-LC prebuilt assembly objects and chrono 0.4.45. Cargo.lock is now retained. See rust-network.md for diagnostic evidence, security properties and reproduction commands.

## Remaining limitations

Native Cargo/Windows curl HTTPS still fails at Schannel credential acquisition. Dependency access works through Node.js verified HTTPS and the local cache; Windows trust/security settings were not modified. The helper depends on Cargo's current internal cache format. No insecure certificates, TLS bypass flags, disabled revocation settings or unverified mirrors were introduced.

No WASM artifact, sandbox integration tests, deployment or real-fund activity occurred. Native mock tests do not demonstrate deployed contract behavior or constitute an audit. Full runtime recovery, signed checkpoints, escrow implementation, monitoring and production validation remain pending.

## Preserved Phase 1 JavaScript results (not rerun in this Rust-only task)

Initial project inspection found an empty directory with no Git repository. Earlier npm install completed with --ignore-scripts and workspace-local cache, reporting 0 known vulnerabilities across 34 audited packages. Backend/dashboard TypeScript checks, the Next.js production build, 2 backend tests and local API smoke checks passed. These applications and package-lock.json were preserved unchanged during the Rust investigation.
