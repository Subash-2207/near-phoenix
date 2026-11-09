# PHOENIX recovery / STATEFLOW v4.3 — local Phase 3

Rust library for automatic monitoring, signed checkpoints, backup selection and
payment reconciliation. `phoenix-worker` is a deterministic subprocess task runner
for the failure demonstration; it is a worker-protocol reference, not an LLM
provider integration. Replace the `WorkerHost` implementation to host a particular
AI agent. Workers receive data and an epoch, never NEAR transaction keys.

From the repository root:

```sh
cargo test --manifest-path services/recovery/Cargo.toml --locked
bash scripts/test-phase3.sh
```

The first command runs service/unit tests and a real subprocess kill/restore test
without sockets. The second additionally builds both optimized contracts and runs
all three ephemeral NEAR sandbox integration tests. It never targets public chains.
See [Phase 3 report](../../docs/phase3-validation.md) for actual results.

## Interfaces

- `Plan`: pinned sandbox deployment/execution domain, code and policy hashes,
  registered Ed25519 worker keys and allowed effects. Persist/reuse it across
  coordinator restarts. Never generate a new execution/payment namespace on retry.
- `SignedCheckpoint`: typed versioned domain-separated Ed25519 message with full
  plan hash, epoch, global sequence, previous digest, issuance/expiry and task data.
  Strict signature verification rejects tampering, wrong domains, keys and plans.
- `CheckpointStore`: content-addressed immutable-by-API blobs, 1 MiB limit,
  fsync and atomic no-replace publication; the finalized on-chain head chooses the
  blob. An orphan disk blob is not a committed checkpoint. Files use mode 0600 on
  Unix. Use a trusted private directory and exclude secrets from task payloads.
- `Coordinator::save`: verifies the worker epoch, signature, sequence, lineage and
  progress before persisting and anchoring the digest in PHOENIX Core.
- `Coordinator::heartbeat`: accepts only a fresh, monotonically sequenced signed
  pulse from the current worker/epoch; it never fabricates liveness itself.
- `monitor`: cancellable polling loop, forwards live worker pulses, detects chain
  heartbeat expiry, reports the crash, selects the first configured ready backup
  proving key possession, requests independent authorization and restores state.
- `Verifier`: separate signing authority. The sandbox implementation re-verifies
  signatures/anchors, fences REWIND first, then grants exact-checkpoint/backup
  recovery. Payment approval independently checks the pinned effect and epoch.
- `Chain`: authenticated adapter. Concrete local-only implementation is in
  `integration-tests/src/sandbox_adapter.rs`. PHOENIX snapshots use one finalized
  block; mutations wait for final receipt status. Transport failures propagate.
- `WorkerHost::restore`: idempotent per deployment/agent/epoch. Startup after a
  successful recovery can reconstruct the same restoration from the anchored head
  without incrementing the epoch again. Repeated delivery never rewinds a worker.
- `execute_payments`: stable domain/task/effect IDs independent of worker, epoch,
  checkpoint sequence or replay. Queries REWIND before dispatch, compares the full
  intent, and skips Succeeded. Pending/Uncertain wait; Failed/Cancelled are terminal.
  No timeout creates a new payment ID. Old reservations require fresh verifier
  approval for the new epoch while retaining the original ID.

`CheckpointStore::lease` excludes multiple writers on the same local filesystem.
A dead coordinator can leave a lease file; it is deliberately not stolen by elapsed
time. Confirm the process is dead and inspect chain state before manual removal.
The contract fences provide the payment boundary across stale sessions; this file
lease is not a distributed consensus service.

## Trust and availability

The owner pins worker policy. The coordinator holds the existing NEAR operator /
vault executor authority; the sentinel retains the distinct verifier key. Workers
hold only their Ed25519 checkpoint/heartbeat keys. On-chain digests attest that the
coordinator anchored bytes; the contract does not itself verify Ed25519 checkpoint
signatures. The independent sentinel verifies them before recovery/payment approval.
Signatures prove integrity and signer identity, not correctness of model reasoning.

Every activated epoch needs a new checkpoint before another crash can recover it.
The initial backup pool is bounded and consumed on recovery. Missing/corrupt/expired
checkpoints, no healthy backup, denied authorization, RPC ambiguity and containment
fail closed. A crash between vault fencing and PHOENIX recovery leaves spending
blocked and can resume the same grant while its checkpoint remains valid. An
uncertain native transfer remains locked until its authentic callback. No automatic
receipt-outcome override, new-ID retry or financial bypass exists.

The supplied deterministic worker uses JSON lines on stdin/stdout and seeds only
on stdin. Sandbox fixtures use explicitly test-only worker seeds; NEAR sandbox
accounts/keys are separately ephemeral. Production key management, host/container
isolation, untrusted-model execution, bounded worker IPC timeouts, multi-host
orchestration, independent task-result proof policies and audits remain separate
work. There is no new public HTTP execution/payment endpoint.
