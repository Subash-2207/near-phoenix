#!/usr/bin/env bash
# Local tests and ephemeral sandbox accounts only; never deploy to a public network.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
cargo test --workspace --locked
cargo test --manifest-path services/recovery/Cargo.toml --locked \
  --target-dir "$PWD/services/recovery/target"
cargo build --manifest-path services/recovery/Cargo.toml --locked \
  --target-dir "$PWD/services/recovery/target" --bin phoenix-worker
bash scripts/build-near.sh
cargo test --manifest-path integration-tests/Cargo.toml --locked -- --nocapture
