#!/usr/bin/env bash
# Build and run the unified recovery demo entirely in disposable NEAR Sandbox.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

evidence_output="${PHOENIX_DEMO_EVIDENCE_OUTPUT:-${TMPDIR:-/tmp}/near-phoenix-phase7b-demo-$(date -u +%Y%m%dT%H%M%SZ)-$$.json}"

printf '\n== Build optimized local contract artifacts ==\n'
bash scripts/build-near.sh

printf '\n== Build recovery worker ==\n'
cargo build --locked --manifest-path services/recovery/Cargo.toml \
  --target-dir "$PWD/services/recovery/target" --bin phoenix-worker

printf '\n== Build backend ==\n'
npm run build -w @phoenix/backend

printf '\n== Run unified recovery through the backend success gate ==\n'
PHOENIX_DEMO_EVIDENCE_OUTPUT="$evidence_output" node scripts/test-phase7-backend-api.mjs
printf "\nSaved this run's Sandbox evidence to: %s\n" "$evidence_output"
