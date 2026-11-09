# Phase 3 implementation and validation — 2026-11-04

Phase 3 implements off-chain recovery and STATEFLOW, with on-chain checkpoint-bound
recovery and payment epoch fencing. The original 78 Rust contract tests remain
present and passing. No public-network deployment or real funds were used.

## Implemented behavior

- A cancellable monitor forwards fresh signed worker heartbeats and detects primary
  failure from finalized PHOENIX chain time. The coordinator never fabricates a
  worker heartbeat merely because its own process is alive.
- Owner-configured worker keys and a bounded, ordered backup pool select only a
  registered backup presenting a fresh signed readiness proof for the next epoch.
- STATEFLOW signs a typed versioned domain including sandbox deployment, both
  contracts, agent/task/execution, code/policy/plan hashes, signer, epoch, global
  sequence, previous digest, issue/expiry times and task state. Ed25519 strict
  verification and pinned serialization reject altered evidence and wrong domains.
- Content-addressed blobs use a 1 MiB bound, fsync and atomic no-replace publication.
  The finalized chain head, not a mutable local "latest" file, chooses restoration.
  Missing/corrupt/expired blobs and stale/forked sequences fail closed.
- PHOENIX opt-in policy binds recovery approval to exactly the current generation,
  checkpoint digest, backup key and checkpoint expiry. Legacy recovery APIs cannot
  bypass it. Containment revokes the grant; consuming it increments the epoch.
- REWIND opt-in fencing is enabled by the depositor before principal is spent.
  Only its independent verifier can advance the epoch. Legacy payment APIs cannot
  bypass a fenced task, and an old Reserved approval requires renewed verifier
  approval under the new epoch. In-flight callbacks continue to reconcile safely.
- The sentinel fences old spending before granting PHOENIX recovery. A partially
  completed handoff blocks payments and can reconcile the same grant on retry;
  it never assumes the two contracts execute atomically.
- Stable deployment/task/effect IDs survive worker, checkpoint and epoch changes.
  The coordinator verifies the complete stored intent before acting: Succeeded is
  skipped, Pending/Uncertain wait, Failed/Cancelled stop. No timeout creates a new
  ID or unlocks an uncertain transfer. Vault tombstones independently reject replay.
- A restarted coordinator can reconstruct a completed recovery from its chain
  head. Worker restoration is idempotent; repeated delivery does not rewind a
  process that has already continued work. The local filesystem lease is never
  stolen on a timeout.

Core and REWIND remain separate financial/lifecycle authorities. Worker Ed25519
keys are distinct from NEAR operator and verifier accounts. The local adapter
rechecks roles and binds its deployment to the pinned plan. PHOENIX observations
come from one finalized block; mutation calls explicitly wait for Final status.
No authorization, lifetime budget, solvency, storage bond, private callback,
refund-race or uncertain-outcome check was disabled.

## Failure demonstration

`integration-tests/examples/phase3.rs` runs the same scenario as the new sandbox
test. It creates only ephemeral local accounts, starts an actual worker subprocess,
computes one step and commits a signed checkpoint. A payment settles, but the
primary is killed before a new checkpoint acknowledges it. Sandbox time advances
to expire the heartbeat. The coordinator detects/reports the crash, rejects tampered
evidence, selects the authorized backup and obtains a separately verified grant.
The backup restores at epoch 1, continues computation and anchors sequence 2.

The restored task asks for the same economic effect. The coordinator observes
Succeeded instead of resending it. Forced duplicate reservation and settlement
calls also check REWIND's exact rejection reasons, and the recipient balance must
have increased exactly once. Old worker generations, stale payment epochs and
unauthorized callers are rejected. Worker children start with an empty environment;
checkpoint signing seeds arrive over stdin, never command-line arguments or logs.

The deterministic task runner demonstrates the worker protocol. No external LLM
provider, production model executor or public payment API was introduced.

## Actual results in this execution session

| Check | Actual result |
| --- | --- |
| PHOENIX Core native unit tests | **29 passed**: original 16 plus 13 Phase 3 tests |
| REWIND native unit/receipt tests | **73 passed**: original 62 plus 11 Phase 3 tests |
| Recovery/STATEFLOW unit tests | **24 passed** |
| Real worker subprocess crash/restore integration | **1 passed**, including continued state and idempotent redelivery |
| Native total | **127 passed, zero failed or ignored**; doc-tests 0 |
| Both cargo-near optimized contract builds | **Passed**, wasm-opt enabled |
| Reviewed WASM import/export audit | **Passed**, PHOENIX 12 imports, REWIND 24; no generic Promise/new-protocol imports introduced |
| Sandbox integration test compilation | **Passed**; all three tests compile |
| Standalone sandbox example build | **Passed** |
| Clippy `--all-targets -- -D warnings`, all three Rust workspaces | **Passed** |
| Formatting checks, all three Rust workspaces | **Passed** |
| New shell script syntax / actual full validation script | Syntax passed; script runs native tests/builds, then stops at sandbox startup |
| Sandbox runtime tests in this session | **0 passed, 3 failed before deployment**: `Could not startup and run sandbox node` / `Error while creating a socket` |
| Original two sandbox tests in normal Ubuntu before Phase 3 | Both passed, **as reported by the user**, not rerun successfully inside this restricted session |
| Full Phase 3 sandbox payment/recovery demonstration | **Not yet runtime-verified**; normal Ubuntu terminal required |

Native coverage includes signature/payload/key/domain/plan tampering, expiry,
sequence/lineage/progress rollback, store corruption, local lease exclusion,
worker pulse replay, healthy/dead-primary monitoring, readiness selection,
independent refusal, containment, stale sessions, recovery restart, exact payment
identity, lost-ack replay, and Pending/Uncertain/terminal no-retry behavior. Contract
coverage adds grant replay/expiry/roles/backup binding, legacy bypass rejection,
epoch-bound approval renewal, safe late callbacks and fenced refunds.

Fresh artifact details are retained in `artifacts/near-wasm-manifest.json`:

| Contract | Optimized path | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| PHOENIX | `target/near/phoenix_core/phoenix_core.wasm` | 162250 | `1c0dd2b7d406dc2156ad6b6874351eb9815c71ccb8595a6a265f007b39aef13e` |
| REWIND | `target/near/rewind_vault/rewind_vault.wasm` | 188019 | `9c2c5b1d2a819a148894aaebe179bb3dccae5632044a54576aa5edb99ffc0a55` |

SDK 5.30.0 still declares minimum protocol 88. The cached sandbox is nearcore
2.13.4 / protocol 86. As in the preceding link fix, these artifacts use only the
reviewed storage/context/native-transfer/callback host subset; no broad claim of
SDK-wide protocol-86 compatibility is made. The original two sandbox test bodies
remain intact. Contract state layouts changed: tests/dev demonstrations deploy
fresh instances, not an in-place upgrade of older Borsh state.

## Reproduce from the normal Ubuntu terminal

```sh
cd /path/to/near-phoenix
bash scripts/test-phase3.sh
```

This performs the native tests, builds the exact worker path, builds/audits both
optimized WASMs, and runs all three sandbox tests. To run the demonstration alone
after building:

```sh
cargo run --manifest-path integration-tests/Cargo.toml --locked --example phase3
```

Individual checks:

```sh
cargo test --workspace --locked
cargo test --manifest-path services/recovery/Cargo.toml --locked
cargo build --manifest-path services/recovery/Cargo.toml --locked --bin phoenix-worker
bash scripts/build-near.sh
cargo test --manifest-path integration-tests/Cargo.toml --locked -- --nocapture
```

`CARGO_NET_OFFLINE=true` works with this session's populated caches. Locked files
are retained for the contracts, service workspace and integration workspace.
Captured validation logs are under `artifacts/phase3/`. Socket restrictions, not
assertion failures, currently prevent local validator execution here.

## Remaining limitations

- The new full sandbox scenario must be run in normal Ubuntu; receipt timing,
  finality waits, gas costs and the cross-contract handoff are not claimed verified
  by native mocks or an import audit.
- Checkpoint signatures are verified off chain by coordinator and sentinel. Core
  anchors and binds their digest; it does not itself verify the signature. Integrity
  and signer identity do not prove semantic correctness of an AI result.
- The demo's signer roles are distinct accounts but share one harness;
  near-workspaces manages dev root/deployment keys. Production key isolation,
  worker/container/egress isolation, model-provider integration, bounded IPC and a
  supervised long-running service deployment remain separate work.
- Each new epoch must save a checkpoint before it can fail over again. Backups are
  consumed from an immutable bounded pool. Missing evidence, no backup and denied
  authorization stop recovery safely rather than inventing state.
- Local lease files are not multi-host consensus. A coordinator process crash can
  leave a lease needing operator inspection/removal. A lost native transfer callback
  can still lock uncertain funds indefinitely; no administrator outcome override or
  timeout retry was added.
- No migration, mainnet deployment, real funds or independent audit was performed.

Implementation entry points: `services/recovery`,
`contracts/phoenix-core/src/phase3_tests.rs`,
`integration-tests/src/sandbox_adapter.rs`, and
`integration-tests/src/recovery_sandbox.rs`.
