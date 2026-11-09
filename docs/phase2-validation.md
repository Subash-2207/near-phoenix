# Phase 2 implementation and validation ? 2026-11-04

## Actual results

| Check | Result |
|---|---|
| cargo fmt --all -- --check | Passed, exit 0 |
| cargo check --workspace --all-targets --offline --locked | Passed, exit 0, no warnings |
| cargo clippy --workspace --all-targets --offline --locked -- -D warnings | Passed, exit 0 |
| cargo test --workspace --offline --locked | Passed: phoenix-core 16/16; rewind-vault 59/59; 75 total, 0 failed, 0 ignored |
| Contract doc-tests | Completed successfully; 0 tests in either crate |
| node scripts/build-wasm.mjs | Passed; both release WASM artifacts generated and inspected |
| Node WebAssembly.Module parsing and import/export inspection | Passed for both; NEAR env-only function imports and required contract exports present |
| Sandbox integration | Not run: native Windows unsupported by available official sandbox tooling; no near-sandbox binary, WSL installation, or Docker executable available |
| Dashboard/backend preservation | Eight previously recorded source/manifest/JavaScript lockfile hashes unchanged; no app code edits |
| Deployment and funds | No network deployment, wallet use or real funds |

The initial 44 vault tests passed. A review replaced deprecated unbounded promise-result reads with promise_result_checked(0, 0), and expanded coverage to 59 tests. Final workspace tests ran after those changes: PHOENIX completed in 0.15s and REWIND in 0.98s, excluding compilation. There were no failing assertions to fix. New legacy collection support uses already cached NEAR SDK dependencies; no unverified downloads or TLS bypasses were needed.

## Artifacts

Built with rustc 1.99.1 / LLVM 23.1.1, release profile, wasm32-unknown-unknown, --cfg near. NEAR SDK 5.30.0 declares minimum protocol version 88. This is a local direct Cargo build, not cargo-near ABI generation, wasm-opt optimization, a reproducible-build attestation, or proof of runtime acceptance. Node parsing/import checks are structural only. Cargo-near was not installed. No claim of a successful sandbox deployment is made.

| Contract | Verified artifact path relative to repository | Bytes | SHA-256 |
|---|---|---:|---|
| phoenix-core | target/wasm32-unknown-unknown/release/phoenix_core.wasm | 244118 | e35db609131c5010e6d51f8cc4eea1d47603da10254198620fb58a12b9151856 |
| rewind-vault | target/wasm32-unknown-unknown/release/rewind_vault.wasm | 330154 | 5f6ee1d685523c2c80c74009efdff96896762369313b7fa1a2ce2f3695edbe11 |

The repository root is D:\Projects\near-phoenix. Full imports, exports, compiler metadata, Cargo.lock checksum and contract source checksums are recorded in ../artifacts/wasm-manifest.json. The artifacts are under ignored target/; rebuild with the supplied helper if that directory is removed.

The missing WASM standard library was downloaded from official static.rust-lang.org over verified HTTPS. Its SHA-256 was checked against the installed compiler's distribution manifest: 5f628f857dd00a8aa3fcac2e275665d2782066a5795274ed124c5b560f46423c. It was extracted into ignored .rust-local, not installed into the global Rust toolchain. scripts/build-wasm.mjs reproduces this setup and supplies the local target sysroot only to target compilation. Global certificate trust and Rust installations remain unchanged.

## Reproduce from the repository root

```powershell
node scripts/cache-rust-dependencies.mjs
$env:CARGO_HOME = Join-Path (Get-Location) '.cargo-local'
$env:AWS_LC_SYS_PREBUILT_NASM = '1'
cargo fmt --all -- --check
cargo check --workspace --all-targets --offline --locked
cargo test --workspace --offline --locked
cargo clippy --workspace --all-targets --offline --locked -- -D warnings
node scripts/build-wasm.mjs
```

## Security coverage and limits

Vault tests cover unauthorized executor/admin withdrawals and refund approval, immutable recipient allowlists and lifetime budgets, missing attached principal/storage bonds, aggregate limits, per-task isolation, conservation, generated native transfer receipts and their callback dependencies, independent commitment approval, duplicate dispatch/IDs/callbacks, failure rollback and new-ID retry, reserved/pending/uncertain refund races, early/expired refunds, unexpected callback data, callback result cardinality and predecessor, maximum storage records, insufficient backing/gas, emergency safe mode and late outcome reconciliation.

Mock tests inspect receipts; they do not execute validator receipt ordering, network refunds, runtime gas costs or WASM storage rollback. On supported Linux x86-64 or macOS ARM64 infrastructure, the next validation step is a compatible protocol-88-or-newer local sandbox exercising initialization, both contract WASMs, native success/failure receipts, asynchronous refunds, duplicate transaction attempts and real callback gas/storage costs. Select a sandbox version compatible with the pinned SDK, rather than assuming an older default binary is sufficient.

Uncertain transfers remain locked until an authentic callback resolves them. If a callback is permanently lost or fails, there is no historical receipt proof recovery endpoint yet. Off-chain verifier evidence validation, process recovery integration, UI/payment wiring, fuzzing, dependency vulnerability review and independent contract audit remain unfinished. No real funds should be entrusted on the basis of these native tests alone.

## Primary references

- Sandbox supported platforms: https://github.com/near/near-sandbox-rs
- Cargo-near target/cfg and protocol-version checks: https://github.com/near/cargo-near/blob/main/cargo-near-build/src/near/build/mod.rs
- NEAR SDK source and native tests: https://github.com/near/near-sdk-rs
- The exact SDK minimum protocol declaration was inspected in .cargo-local/registry/src/index.crates.io-1949cf8c6b5b557f/near-sdk-5.30.0/Cargo.toml.
