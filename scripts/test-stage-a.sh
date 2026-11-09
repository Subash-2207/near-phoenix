#!/usr/bin/env bash
# Repeatable Stage A proof-of-recovery validation; integration deploys ephemeral local sandbox only.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

printf '\n== Rust formatting ==\n'
cargo fmt --all -- --check
cargo fmt --manifest-path services/recovery/Cargo.toml -- --check
cargo fmt --manifest-path integration-tests/Cargo.toml -- --check

printf '\n== Contract unit tests ==\n'
cargo test --workspace --locked

printf '\n== Recovery service tests ==\n'
cargo test --manifest-path services/recovery/Cargo.toml --locked \
  --target-dir "$PWD/services/recovery/target"

printf '\n== Build and import-audit NEAR WASM ==\n'
bash scripts/build-near.sh

printf '\n== Local sandbox integration tests ==\n'
cargo test --manifest-path integration-tests/Cargo.toml --locked -- --nocapture

printf '\nStage A validation completed successfully. No public network or mainnet is used.\n'
