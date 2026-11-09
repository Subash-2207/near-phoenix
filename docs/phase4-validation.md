# Phase 4 SENTINEL and GUARDIAN

## Implemented

SENTINEL approvals share a bounded Borsh signing format across PHOENIX Core,
REWIND and the recovery service. They bind the deployment, action, requester,
worker key, epoch, security revision, checkpoint, operation, recipient, amount,
commitment, nonce and short expiry. Core and REWIND verify Ed25519 signatures
on-chain and consume monotonically increasing nonces. Protected REWIND tasks
require both their designated NEAR verifier and a fresh SENTINEL ticket. Core's
legacy recovery approval route is disabled when SENTINEL is configured. Generic
Core approvals cover only nonfinancial capabilities; Core does not execute an
external action. A downstream host must consume its final authorization receipt
exactly once.

GUARDIAN accepts signed, source-authenticated security events, detects repeated
authorization failures, unexpected transfer intents, stale/abnormal worker
activity and configured high risk signals. It writes a signed, append-only local
audit chain and anchors each record's digest/sequence in Core. Startup verifies
local history against that anchor and reconciles one pending stop/anchor intent.
Quarantine is task/agent scoped, increments the security revision and blocks new
settlement while leaving authentic callbacks and authorized refund handling live.
Only the owner can release a task pause; Core recovery remains subject to the
independent checkpoint-bound recovery process. Risk scores can trigger a stop,
but cannot approve payment or release a quarantine.

The adversarial tests cover forged/modified signatures, replay, wrong task/worker,
expired approvals, bad budgets/recipients, stale epochs, duplicate evidence,
unexpected transfers, audit tampering/truncation, interrupted reconciliation,
and risk signals without spending authority. The Phase 4 sandbox test exercises
the contract-level signed-payment boundary, duplicate settlement rejection,
separate guardian pause authority, audit anchoring and unauthorized access.

The combined runnable demo executes the Phase 3 primary-crash/backup-recovery
scenario and then the Phase 4 approval/quarantine scenario in fresh local
deployments:

```sh
cargo run --manifest-path integration-tests/Cargo.toml --locked --example phase4
```

## Validation

`bash scripts/test-phase4.sh` runs root/service unit suites, builds the worker and
optimized NEAR WASM, audits imports/exports, then runs all local sandbox tests.
From a normal Ubuntu terminal, the focused Phase 4 sandbox test is:

```sh
cargo test --manifest-path integration-tests/Cargo.toml --locked -- --nocapture sentinel_and_guardian_enforce_payment_and_quarantine
```

The Codex execution environment cannot create localhost sockets. The latest
attempt therefore failed during sandbox-node startup for all four integration
tests (`Could not startup and run sandbox node: Error while creating a socket`);
this is an environment limitation, not a passing sandbox result. Run the command
above and then `bash scripts/test-phase4.sh` in normal Ubuntu to validate runtime
behavior. Do not point either command at mainnet/testnet.

## Operational limits

The integration fixture uses ephemeral sandbox accounts and deterministic test
Ed25519 seeds. Production signing keys need independent custody and rotation.
Observer signatures authenticate the event source, but production adapters must
derive transfer and authorization evidence from finalized RPC receipts; a signed
claim alone does not prove a receipt's semantics. The audit directory is local,
so production requires durable protected storage and independent supervision.
Fail-closed lease cleanup, key rotation, multisig administration, external action
execution, model integration and independent security review remain future work.
Phase 4 changes contract state layouts; use fresh sandbox deployments.
