#!/usr/bin/env bash
# Build the exact optimized artifacts used by the local integration tests.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
for crate in phoenix-core rewind-vault; do
  artifact_name="${crate//-/_}"
  cargo near build non-reproducible-wasm --locked --no-abi \
    --manifest-path "contracts/$crate/Cargo.toml" \
    --out-dir "$PWD/target/near/$artifact_name"
done
node scripts/inspect-near-wasm.mjs
