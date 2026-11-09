# Phase 6 security and reliability validation

Phase 6 adds adversarial regression coverage around the existing PHOENIX v4.3 controls. It is engineering validation, not a professional security audit.

## Covered controls

- PHOENIX Core recovery uses independent, signed approvals, expiry checks, revision binding, one-time grants, and monotonically advancing recovery generations.
- REWIND keeps task principal accounting separate from storage bonds, binds signed approvals to exact operations, permanently reserves operation IDs, restricts callbacks to the private self-call path, and fails closed on uncertain transfer outcomes. Refunds close a task to new payments and cannot overtake unresolved transfers.
- STATEFLOW verifies signed checkpoints, execution domain, sequence, digest continuity, expiry, and fencing generation before restoration.
- SENTINEL verifies identity, policy, recipient, budget, task/epoch/revision, expiration, signature and nonce; GUARDIAN consumes signed, non-replayed observations, quarantines through scoped on-chain controls, and anchors audit records.
- The local Control Plane only binds to loopback, permits the exact `http://localhost:3000` UI origin, and requires that origin for local demo actions. Demo completion requires observed proof events plus a successful child exit. Backend shutdown terminates the local demo process group and marks interrupted work failed.

## Adversarial regression matrix

Rust unit tests cover forged and replayed signatures, expired approvals/checkpoints, unauthorized settlement/refund/withdrawal, operation-ID reuse, duplicate settlement/callback, refund races, unresolved/uncertain transfers, checkpoint tampering/forks/rollback, stale recovery fencing, quarantine release bypass, audit-chain tampering, and restart reconciliation.

NEAR sandbox tests exercise contract-level forged and expired approval rejection, unauthorized payment attempts, one-time payment IDs, real failed native transfer callbacks, refund-vs-pending-operation rejection, attacker quarantine bypass attempts, independent recovery authorization, and the primary-crash/backup-restore/no-duplicate-settlement flow.

Backend tests exercise strict CORS/preflight behavior, rejected origins, live telemetry polling, event-gated demo success, tampered audit data, and shutdown/restart behavior.

## Run

From the project root run `bash scripts/test-phase6.sh`. The contract and integration artifacts are local, and the integration suite uses ephemeral sandbox accounts only. The script does not deploy to a public network or use real funds.

## Limits

Process-local Control Plane/demo state is not durable across restarts; shutdown reports an active demonstration as interrupted instead of resuming it. The local demo API is intended for a trusted workstation and is not an authentication boundary against other local processes. Recovery key custody, production RPC/node operation, deployment configuration, and independent review remain outside this validation scope. Sandbox results do not prove deployed-chain behavior under every protocol configuration.
