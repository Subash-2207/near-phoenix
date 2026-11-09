#!/usr/bin/env bash
# Create a local source-only review archive. This script never uploads or publishes.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="${1:-/tmp/near-phoenix-v4.3-submission-$(date -u +%Y%m%dT%H%M%SZ).tar.gz}"
output_dir="$(dirname "$output")"
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"
output="$output_dir/$(basename "$output")"
if [[ -e "$output" ]]; then
  printf 'Refusing to overwrite existing archive: %s\n' "$output" >&2
  exit 2
fi

tar -czf "$output" -C "$root" \
  --exclude='./.git' \
  --exclude='./.aws' \
  --exclude='./.agents' \
  --exclude='./.codex' \
  --exclude='./.cargo-local' \
  --exclude='./.rust-local' \
  --exclude='./node_modules' \
  --exclude='./target' \
  --exclude='*/target' \
  --exclude='*/node_modules' \
  --exclude='*/.next' \
  --exclude='*/dist' \
  --exclude='*.tsbuildinfo' \
  --exclude='*.log' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='*/.env' \
  --exclude='*/.env.*' \
  --exclude='near-credentials.json' \
  --exclude='*.pem' \
  --exclude='*.key' \
  --exclude='*.seed' \
  --exclude='./artifacts/network-diagnostics.json' \
  --exclude='./artifacts/wasm-manifest.json' \
  --exclude='./scripts/diagnose-network.py' \
  --exclude='./scripts/build-wasm.mjs' \
  --exclude='./docs/wsl-network-investigation.md' \
  --exclude='./docs/rust-network.md' \
  --exclude='./docs/validation.md' \
  --exclude='./docs/ubuntu-validation.md' \
  --exclude='./docs/phase2-validation.md' \
  .
printf 'Local source archive created: %s\n' "$output"
printf 'Review the archive contents before sharing. This command did not upload or publish it.\n'
