#!/usr/bin/env bash
# Phase 6 local security/reliability validation. Integration tests use ephemeral NEAR sandbox only.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

failures=0
run_stage() {
  local label="$1"
  shift
  printf '\n== %s ==\n' "$label"
  if "$@"; then
    printf 'PASS: %s\n' "$label"
  else
    local result=$?
    printf 'FAIL (%s): %s\n' "$result" "$label"
    failures=$((failures + 1))
  fi
}

run_stage "Root Rust formatting" cargo fmt --all --check
run_stage "Recovery Rust formatting" cargo fmt --manifest-path services/recovery/Cargo.toml --check
run_stage "Integration Rust formatting" cargo fmt --manifest-path integration-tests/Cargo.toml --check
run_stage "Contract unit tests" cargo test --workspace --locked
run_stage "Recovery unit and process tests" cargo test --manifest-path services/recovery/Cargo.toml --locked \
  --target-dir "$PWD/services/recovery/target"
run_stage "Recovery worker build" cargo build --manifest-path services/recovery/Cargo.toml --locked \
  --target-dir "$PWD/services/recovery/target" --bin phoenix-worker

run_stage "Backend and dashboard TypeScript checks" npm run typecheck --workspaces --if-present
run_stage "Backend tests" npm test -w @phoenix/backend
run_stage "Dashboard wallet session tests" npm run test:wallet -w @phoenix/dashboard
run_stage "Dashboard evidence metric tests" npm run test:evidence -w @phoenix/dashboard
run_stage "Dashboard recovery transition tests" npm run test:transitions -w @phoenix/dashboard
run_stage "Phase 8B proof-evidence classification tests" npm run test:phase8b
run_stage "NEAR-compatible contract WASM builds and import audit" bash scripts/build-near.sh
run_stage "Local NEAR sandbox integration tests" cargo test --manifest-path integration-tests/Cargo.toml --locked -- --nocapture --test-threads=1
run_stage "Dashboard production build" npm run build -w @phoenix/dashboard

if (( failures > 0 )); then
  printf '\nPhase 6 validation completed with %s failed stage(s).\n' "$failures"
  exit 1
fi
printf '\nAll Phase 6 validation stages passed.\n'
