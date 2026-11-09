# PHOENIX / REWIND local sandbox tests

This separate Rust workspace keeps RPC dependencies out of contract WASM builds.
It starts a local `near_workspaces::sandbox()` with disposable accounts and
balances. No public-network configuration or real wallet is used.

Run from the repository root in a normal Ubuntu terminal:

```sh
cargo test --workspace --locked
bash scripts/build-near.sh
cargo test --manifest-path integration-tests/Cargo.toml --locked -- --nocapture
```

The build script requires the installed `cargo-near` CLI. It uses the locked
SDK 5.30.0, enables wasm-opt, and writes exactly these optimized binaries:

- `target/near/phoenix_core/phoenix_core.wasm`
- `target/near/rewind_vault/rewind_vault.wasm`

Tests print their deployed paths and sizes. They never fall back to
`target/wasm32-unknown-unknown/release`. Run the build before testing changed
contract code. `node scripts/inspect-near-wasm.mjs` inspects those same files and
writes SHA-256 hashes and reviewed imports to `artifacts/near-wasm-manifest.json`.
The import audit fails on unreviewed imports, including the SDK generic Promise
imports that caused the original link error. Do not remove imports from a WASM
binary or disable contract authorization checks to pass the audit.

PHOENIX coverage: authorized recovery, denied forged heartbeats/approvals,
recovery replay rejection, and containment during pause.

REWIND coverage: attached native deposits, recipient budgets, insufficient funds,
executor and verifier authorization, private callbacks, reserved-payment/refund
exclusion, exact recipient balance increase, duplicate settlement/ID rejection,
failed native transfer reconciliation, and refund of remaining principal. A
failed native transfer callback is expected to return false and restore accounting;
a permanently failed callback is a different condition and remains locked.

Actual locked tooling is near-workspaces 0.23.0 with near-sandbox 0.3.16, whose
installed binary reports nearcore 2.13.4 / protocol 86. SDK metadata declares
minimum protocol 88; the generic Promise action dispatcher imported newer host
functions unavailable to this runtime. REWIND now constructs only its native
transfer and callback with SDK env primitives. Its 24 resulting imports are present
in the older runtime's host interface. This resolves the identified link mismatch
without claiming full SDK 5.30 compatibility for protocol 86 or enabling newer
protocol features. Future use of those SDK features requires a compatible runtime.

Current results: all 78 unit tests pass; both optimized WASM builds and import
audits pass. Integration tests compile, but this execution session cannot start
sandbox sockets. The user previously reported PHOENIX passing and REWIND failing
at linking; runtime results for the fix still need the normal-terminal command
above. See [link investigation](../docs/wasm-link-fix.md).

## Phase 3

`bash scripts/test-phase3.sh` now builds the worker, runs all native tests and builds
both contracts before running all three sandbox tests. The added test shares its
implementation with a runnable local example:

```sh
cargo run --manifest-path integration-tests/Cargo.toml --locked --example phase3
```

Build the worker first if bypassing the script:
`cargo build --manifest-path services/recovery/Cargo.toml --locked --bin phoenix-worker`.
The demo uses real subprocess failure, signed durable checkpoints, finalized
PHOENIX observations, distinct coordinator/sentinel accounts, on-chain recovery and
REWIND epoch fencing. It verifies exactly one native payment despite restoration
from a checkpoint predating payment acknowledgment, then anchors resumed backup
work. Negative calls check the expected rejection reason, not merely any RPC error.
The original two integration test bodies remain intact. Current Phase 3 runtime
results still require a normal Ubuntu terminal; see ../docs/phase3-validation.md.
