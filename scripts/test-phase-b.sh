#!/usr/bin/env bash
# Phase B mesh checks; deploys contracts only to an ephemeral local sandbox.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

cargo fmt --all -- --check
cargo fmt --manifest-path services/recovery/Cargo.toml -- --check
cargo fmt --manifest-path integration-tests/Cargo.toml -- --check
cargo test --workspace --locked
cargo test --manifest-path services/recovery/Cargo.toml --locked \
  --target-dir "$PWD/services/recovery/target"
cargo build --manifest-path services/recovery/Cargo.toml --locked \
  --target-dir "$PWD/services/recovery/target" --bin phoenix-worker
bash scripts/build-near.sh
cargo test --manifest-path integration-tests/Cargo.toml --locked -- --nocapture

printf '\nPhase B validation complete. No public network or real funds were used.\n'
