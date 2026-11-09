# NEAR PHOENIX v5.0 — Phase 7 Integration Report

**Date:** 2026-11-09

**Scope:** Inspection and test-only validation. No functional source, contract, wallet, or UI changes were made for this report. No public network or real funds were used.

## Result

> This section records the initial Phase 7 inspection. The Phase 7B addendum at the end supersedes its statement that the cohesive workflow is unproven.

The current implementation passes its contract, service, backend, dashboard, WASM, and five local NEAR Sandbox integration tests when the sandbox is allowed to create localhost sockets. The local backend demo also completed with 12 observed events and exit code 0.

The requested final claim is **not yet proven as one complete workflow**. Recovery, SENTINEL/GUARDIAN handling, and Proof-of-Recovery are exercised in separate sandbox deployments/tests. The backend considers the Phase 5 demo successful without requiring a recovery receipt, and its Phase 5 driver deliberately runs recovery and the SENTINEL/GUARDIAN drill in separate deployments. No production recovery-service adapter connects the coordinator to finalized RPC and live contract actions. The API's live control-plane response was correctly unavailable because no persistent local contract IDs were configured. There is no browser automation installed for a dashboard console-level test.

No failing contract assertion indicates a contract change is needed. This pass did not modify contracts.

## Test commands and results

| Command | Result |
|---|---|
| `CARGO_NET_OFFLINE=true bash scripts/test-phase6.sh` | Exit 1 only because the five sandbox tests could not create sockets under the default execution restriction. All other stages passed, including the later production build. |
| `CARGO_NET_OFFLINE=true cargo test --manifest-path integration-tests/Cargo.toml --locked -- --nocapture` (rerun with local socket permission) | **5 passed, 0 failed** in 36.85s. All five tests deployed only to ephemeral `near_workspaces::sandbox()` accounts. |
| `CARGO_NET_OFFLINE=true cargo run --locked --manifest-path integration-tests/Cargo.toml --example phase5` (local sandbox) | **Passed**, exit 0. The example emitted 12 events and `demo_complete`; recovery and SENTINEL/GUARDIAN use separate sandbox deployments. |
| `cargo test --workspace --locked` (run by Phase 6 script with Cargo offline) | **145 passed**: PHOENIX Core 53, REWIND 92. |
| `cargo test --manifest-path services/recovery/Cargo.toml --locked --target-dir "$PWD/services/recovery/target"` | **57 passed**: service/security 56 and real worker-process test 1. |
| `cargo fmt --all --check`; recovery and integration `cargo fmt ... --check` | **Passed** for all three formatting stages. |
| Recovery worker build | **Passed**. |
| `npm run typecheck --workspaces --if-present` | **Passed** for backend and dashboard. |
| `npm test -w @phoenix/backend` | **Passed**: all 4 test files / 31 declared backend test cases. |
| `npm run test:wallet -w @phoenix/dashboard` | **Passed**: 4/4. |
| `npm run test:evidence -w @phoenix/dashboard` | **Passed**. |
| `npm run test:transitions -w @phoenix/dashboard` | **Passed**. |
| `bash scripts/build-near.sh` (run by Phase 6 script) | **Passed**: optimized PHOENIX Core and REWIND WASM built and import/export audited; 15 and 25 reviewed imports respectively. |
| `npm run build -w @phoenix/dashboard` | **Passed**; production static routes generated. |
| Loopback backend API demo (`PORT=3401`, `NEAR_NETWORK=localnet`) | **Passed**: `POST /api/demo` returned 202; polling returned `succeeded`, exit 0, and 12 events. `/api/control-plane` returned HTTP 200 with `configured:false`, `source:unavailable`, and the expected missing-contract-ID message. |

The first sandbox attempt failed before test setup with `Error while creating a socket`; it was not an assertion failure. The permitted rerun passed. Build artifacts were regenerated locally; the tracked NEAR WASM manifest remained unchanged.

## Implementation classification

| Component | What runs today | What remains simulated or absent |
|---|---|---|
| PHOENIX Core | NEAR contract. Sandbox tests exercise crash reporting, SENTINEL-only approval, backup activation, monotonically increasing generation, containment, and replay/stale-generation rejection. | Production deployment and migration are outside this test. The test keys/accounts are ephemeral. |
| STATEFLOW | Recovery service signs and verifies checkpoints; Core stores and checks checkpoint digest, sequence, expiry, worker identity, and generation. Tampering and stale restoration are tested. | The durable store is local filesystem storage. No production multi-host checkpoint service is configured. |
| SENTINEL | Ed25519 approval and receipt signing are real cryptographic operations; Core and REWIND verify approvals on chain. Receipt tests compare signed checkpoint and finalized REWIND evidence. | Test identities are deterministic and live in one harness. No independent key custody or production finalized-RPC evidence adapter is configured. Core trusts the configured Sentinel to attest REWIND evidence because cross-contract views are not synchronous. |
| GUARDIAN | Signed observer events, local append-only audit verification, on-chain audit anchoring, scoped quarantine, and fail-closed release checks run in unit and sandbox tests. | GUARDIAN does not terminate or isolate an external worker or host. The phase5 demo's GUARDIAN scenario is a separate sandbox deployment from its recovery scenario. |
| REWIND | NEAR escrow contract. Sandbox test verifies real native transfers, exact recipient deltas, private callback processing, rejected duplicate/reused IDs, failure callback accounting, unresolved-operation refund exclusion, and refund of remaining funds. | No real NEAR was used. The sandbox does not simulate a permanently lost callback end to end; uncertainty and late reconciliation are covered by unit tests/mocks. |
| Recovery Service | Coordinator, signed checkpoint logic, worker executable, and monitor run locally. The sandbox scenario kills the primary worker process, restores a backup, continues work, and verifies one settlement. | The concrete `Chain`, `Verifier`, and `SecurityChain` implementations found in this repository are test adapters/mocks. No production RPC/action adapter or supervised deployment is present. |
| Backend | Read-only finalized-RPC telemetry API, local demo launcher, event polling, origin checks, and fail-closed success gating are implemented. Actual `/api/demo` launch and polling passed against local sandbox. | Live telemetry was unavailable in this run because no persistent local contracts/RPC IDs were configured. Demo timestamps are backend receipt times, not chain timestamps. |
| Dashboard | Production build and data/transition tests pass. It consumes demo events from `/api/demo` and live contract state from `/api/control-plane`; the UI labels sandbox events separately. | No browser automation or browser console verification is available. The demo events do not hydrate the live contract-state panel from the demo's ephemeral accounts. |
| Proof-of-Recovery | A separate sandbox test signs and records a receipt that matches Core's recovery transition and a successful, finalized REWIND operation; it checks checkpoint hash equality, signer, epoch, settlement reference/outcome/block, and recipient balance delta. Forgery, altered checkpoint, stale epoch, evidence mismatch, and receipt replay are rejected. | This receipt scenario is not part of the backend Phase 5 demo's event gate and does not include the worker-process crash or GUARDIAN quarantine in the same fixture. |

## Scenario matrix

| Scenario | Result and evidence |
|---|---|
| Primary process failure and backup eligibility | **Passed.** Worker process is killed; preferred backup is made unavailable; signed pulses and configured registry order select an eligible backup. |
| Independent recovery authorization | **Passed in tests.** Missing, forged, wrong-identity, expired, or replayed approvals are rejected; the registered Sentinel path succeeds. Test key separation does not establish independent human custody. |
| Fencing and duplicate recovery/payment protection | **Passed.** Recovery advances epoch 0→1; old coordinator/worker epochs and duplicate payment IDs are rejected; restored execution returns `AlreadyPaid`; observed recipient delta is exactly one payment. |
| Checkpoint integrity/restoration | **Passed.** Signed checkpoint digest agrees across local checkpoint, STATEFLOW head, Core transition, and Sentinel receipt. Tampered, stale, expired, forked, or rolled-back checkpoints fail closed in the applicable suites. |
| GUARDIAN warning/quarantine/fail closed | **Passed in the separate security sandbox.** Forged/untrusted events and unauthorized unpause/reopen attempts are rejected; valid signed authorization-failure evidence leads to scoped pause/containment and an anchored audit head. It does not isolate the worker process. |
| REWIND callback, duplicate, and refund behavior | **Passed for exercised cases.** Successful and failed native transfer callbacks execute; failed delivery returns false and restores accounting; duplicate settlement/operation reuse and refund during unresolved operations are rejected; remaining principal refunds to depositor. |
| Missing/unauthorized approvals | **Passed** in contract/service negative tests and sandbox cases. |
| Proof receipt against actual test evidence | **Passed in a separate receipt sandbox test.** Finalized settlement evidence, recipient delta, operation state, and receipt fields match; malformed, forged, altered, stale, and replayed receipts fail. |
| API/dashboard telemetry consistency | **Partially verified.** Backend API demo returned the same 12 event kinds emitted by the Rust Phase 5 process. Live control-plane telemetry correctly returned unavailable. Browser-level rendering/console behavior was not tested. |
| One unified recovery + Guardian + receipt workflow | **Not present / not proven.** Existing tests divide these checks across fresh deployments; the Phase 5 demo does not require or emit a recovery-receipt verification event. |

## Security and reliability findings

1. **Success-gate scope is narrower than the Phase 7 objective.** `apps/backend/src/demo.ts` requires nine event kinds and a clean exit, but not a signed Proof-of-Recovery receipt. The Phase 5 example emits `demo_complete` after recovery and a separate security deployment. A successful API demo therefore does not prove the one-workflow receipt objective.
2. **No production recovery adapter is present.** `Chain`/`Verifier` and `SecurityChain` are implemented by sandbox adapters and unit mocks, not by a live recovery-service adapter. The backend's RPC reader is read-only and cannot drive autonomous recovery.
3. **Cross-contract operation is non-atomic.** Core, REWIND, Sentinel, and Guardian state changes are separate receipts. A failure between steps can leave a fenced or quarantined state requiring reconciliation. Tests cover selected failure paths, not every process/network interruption point.
4. **Receipt trust boundary is Sentinel.** Core verifies Sentinel's signature, its own transition, epoch, identities, and checkpoint; it cannot query REWIND state itself. Correct settlement evidence depends on Sentinel's finalized-RPC observer and secure key custody.
5. **GUARDIAN is contract-level containment, not host isolation.** It blocks scoped contract actions but does not stop a compromised worker, restrict its network, or protect the host.
6. **Callback loss is still a liveness risk.** A real failed recipient transfer with its callback is tested and reconciled. If the callback never arrives, funds remain uncertain/locked; no timeout or administrator override is implemented. Unit tests cover fail-closed uncertain states, not an actual permanently lost sandbox callback.
7. **Demo timestamps are local observations.** `DemoRunner` stamps events when it reads child output. These are appropriate for per-run local demonstration timings, not chain timestamps or production service-level measurements.
8. **Local API trust is limited to a workstation.** Loopback binding and CORS constrain browser origins but do not authenticate other local processes. No private keys are held by the backend.

## Missing integrations and exact files for follow-up

The P0 work below describes the initial Phase 7 gap and is completed by the Phase 7B addendum. The P1 and P2 follow-ups remain open.

No smart-contract change is currently justified by the passing assertion results. To prove the Phase 7 objective end to end, prioritize:

### P0 — Add one cohesive sandbox scenario and gate demo success on its receipt

- Add a unified scenario such as `integration-tests/src/phase7_sandbox.rs` that uses one fresh Core/REWIND deployment for the real worker crash, checkpoint validation, independent Sentinel approval, epoch fencing, payment, Guardian warning/quarantine, and Sentinel-signed receipt verification. Reuse/refactor `integration-tests/src/recovery_sandbox.rs`, `integration-tests/src/security_sandbox.rs`, and `integration-tests/src/recovery_receipt_sandbox.rs` rather than implying their separate deployments are one trace.
- Add a Phase 7 example and update `integration-tests/examples/phase5.rs` only if the existing demo is intended to represent this complete path.
- Update `apps/backend/src/demo.ts` so success requires receipt-verification evidence tied to the same task, checkpoint digest, source/target epochs, settlement operation, finalized outcome, and clean child exit. Add backend tests for every missing/mismatched proof field.

### P1 — Implement and test the production recovery adapter

- Add a concrete localnet/testnet-only adapter (new `services/recovery/src/near_adapter.rs`, or an equivalent explicitly named module) implementing the existing coordinator and Guardian interfaces in `services/recovery/src/coordinator.rs` and `services/recovery/src/guardian.rs`.
- Keep public-network action safety explicit; test finalized reads, signer-role separation, retries, interruption between Core/REWIND steps, and reconciliation. Do not enable mainnet or real-fund behavior as part of this work.

### P2 — Add real browser verification without changing the finalized design

- Add a browser E2E test for `apps/dashboard/app/phoenix-application.tsx` that consumes the local demo API, confirms the same observed event IDs/status are rendered, checks live telemetry remains unavailable when unconfigured, and fails on hydration or script console errors. No visual redesign is indicated by this test pass.
- Add a sandbox-controlled test for an actually missing/delayed REWIND callback and the operator reconciliation path before treating callback loss as operationally recoverable.

## Run context

All contract and integration scenarios ran against ephemeral local NEAR Sandbox accounts. The backend demo forces `NEAR_NETWORK=localnet`; the read-only API smoke test used `NEAR_RPC_URL=http://127.0.0.1:3030` with no node or contract IDs configured, so it reported telemetry unavailable. No testnet was contacted, no mainnet deployment occurred, and no real NEAR was transferred.

## Phase 7B — Unified Recovery Pipeline (2026-11-09)

### Result

**PASS:** one automated local sandbox scenario now exercises the primary process failure through signed SENTINEL authorization, backup restoration, epoch fencing, a sandbox REWIND payment, Core receipt verification, and GUARDIAN quarantine in the same Core/REWIND deployment. The backend reports demo success only after validating the SENTINEL signature and binding its receipt to the workflow and finalized settlement evidence. No contract or frontend source was changed.

The scenario uses ephemeral near-workspaces Sandbox state and deterministic test-only worker/SENTINEL/GUARDIAN keys. Its escrow transfer is 1 NEAR of sandbox funds. No testnet or mainnet was contacted.

### End-to-end evidence

The unified test `phase7_unified_sandbox_recovery_receipt_and_guardian_fail_closed` passed in the complete five-test integration suite. One observed run produced:

- Core and REWIND IDs: `dev-20261109060541-65163175738752.test.near` and `dev-20261109060541-24358453288773.test.near`.
- Recovery: primary epoch `0` failed; the independent SENTINEL signer authorized the registered backup; Core and REWIND advanced to epoch `1`; the backup restored the anchored checkpoint and continued it.
- Settlement: operation `9976faa9b8cab425cb3457eb551e7d46e04310332838d33eec2476b0a5abef49` paid `1000000000000000000000000` yoctoNEAR (1 sandbox NEAR) once. Finalized REWIND state, recipient balance delta, stale-epoch rejection, duplicate settlement rejection, and operation-ID tombstone were asserted.
- Proof: Core stored the signed receipt for the same task, checkpoint, backup identity, `0 -> 1` transition, and settlement. The receipt names SENTINEL account `dev-20261109060542-16020141790243.test.near`, public key `197f6b23e16c8532c6abc838facd5ea789be0c76b2920334039bfa8b3d368d61`, and finalized settlement block `2180` / `4AbHP7JqZskTiCMkxnF1CqqvDw93da43vStSeJfYdjCi`. Its signed evidence hash was `e99158b792431c7e28d832b93f57142548dd2d66ac78a8c1681d7e39ea3583df`.
- GUARDIAN: it anchored an advisory `Observe` record, then processed a signed authorization-failure event tied to an actual attacker reserve rejection. It paused REWIND and contained the Core agent. A later reserve and coordinator tick both failed closed.
- Backend: `DemoRunner` launched the Phase 7 example and returned `succeeded`, exit code `0`, with the receipt event in the same event stream. The backend recomputed the receipt's Borsh signing bytes, checked Ed25519 against the pinned sandbox SENTINEL public key, recomputed the finalized evidence hash, and matched task, deployment, contract IDs, checkpoint, agent identities, settlement, recipient, amount, and epochs.

The backend API trace is preserved in [PHASE7B-E2E-EVIDENCE.json](PHASE7B-E2E-EVIDENCE.json). `POST /api/demo` returned `202`, the initial state was `running`, and `GET /api/demo` returned `200` with `succeeded`, exit code `0`, and 12 events. Its receipt re-verifies with public key `197f6b23e16c8532c6abc838facd5ea789be0c76b2920334039bfa8b3d368d61`, signature `f24df837ad8f0e52e52294b6bdb302aabb3a47417dc8a593ee1d8e3440d5d4324d562ca2a43e79ec2e602e4ec027250c33820f4e9bbafdc8cd85eee72c25b30b`, settlement reference `0b3db2802b313a786e64c56b546a91d55d8d6c2870a35e0eb0029cdcc866d93f`, and evidence hash `24064268544f2c2452d1fba4cce9ce678f96f1a3ae9332ee3de191664658fdd9`. The backend verifier and complete success gate were also run against this saved event stream after the sandbox run completed. Test account IDs and receipt values vary with each fresh sandbox deployment.

### PASS/FAIL and implementation classification

| Area | Result | Contract calls or simulation |
|---|---|---|
| PHOENIX Core, STATEFLOW | PASS | Actual deployed WASM calls for registration, checkpoint commit, crash report, signed recovery approval, backup activation, epoch advancement, receipt recording, proof view, and audit anchoring. The service checkpoint store and worker process are local test implementations. |
| GUARDIAN | PASS | Actual `Guardian::handle` and signed audit-chain records; the local adapter calls Core/REWIND pause and contain methods. The advisory score is a test signal. Quarantine is tied to an actual failed unauthorized contract call. |
| SENTINEL | PASS | Actual Ed25519-signed recovery and payment approvals are verified by Core/REWIND contract calls. The recovery receipt is produced by the recovery service Sentinel implementation and verified/stored by Core. The signing key is deterministic test-only material. |
| Backup and fencing | PASS | A child worker process is killed; the real recovery coordinator selects and restores an eligible signed backup. Stale checkpoint, old heartbeat/session, epoch, duplicate settlement, and reused operation ID checks reject. Backup candidate availability is controlled by the harness. |
| REWIND | PASS | Actual local contract funding, reserve, signed approval, transfer, callback, finalized operation view, and recipient balance delta. Duplicate settle/reserve and unauthorized reserve are rejected. Existing refund/failed-transfer integration also passes in its separate sandbox test. |
| Proof of Recovery | PASS | Receipt body binds the recovery transition and finalized REWIND evidence; Core stores it and the test reads back the verified account and signature. The backend performs independent cryptographic and cross-event checks before success. |
| Backend APIs / dashboard | PASS with limits | Backend demo snapshot reports only the receipt-verified run as successful; dashboard typecheck, production build, wallet/evidence/transition tests pass without UI changes. No browser automation is installed, so hydration and console behavior were not re-tested in a browser in this phase. |

Negative cases passed: unauthorized recovery, missing independent recovery approval, tampered checkpoint, stale recovery generation, old worker/session epoch, unauthorized settlement, duplicate settlement and reservation, unauthorized reserve, missing/forged/replayed/mismatched backend receipt, and reserve/recovery attempts after Guardian quarantine. Existing sandbox coverage also passed failed native delivery/callback and refund assertions. The initial restricted-socket integration attempt failed before setup with `Error while creating a socket`; the same full suite passed sequentially after local socket access was approved.

### Commands and verified results

| Command | Result |
|---|---|
| `cargo test --offline --locked --workspace` | **PASS**, 145 tests: Core 53, REWIND 92. |
| `cargo test --offline --locked --manifest-path services/recovery/Cargo.toml` | **PASS**, 57 tests: recovery/security 56 and worker-process 1. |
| `cargo test --offline --locked --manifest-path integration-tests/Cargo.toml -- --nocapture --test-threads=1` | **PASS**, 5/5 local sandbox tests; 104.23s. Sequential execution avoids concurrent local Sandbox startup conflicts. Requires loopback socket access. |
| `cargo check --offline --locked --manifest-path integration-tests/Cargo.toml --tests --examples` | **PASS**, includes the `phase7` runner. |
| `cargo fmt --all --check`; `cargo fmt --manifest-path services/recovery/Cargo.toml -- --check`; `cargo fmt --manifest-path integration-tests/Cargo.toml -- --check` | **PASS**. |
| `npm run typecheck` in `apps/backend` and `apps/dashboard` | **PASS**. |
| `npm test -w @phoenix/backend` | **PASS**, all 5 backend test files, including receipt success/rejection coverage. |
| `npm run test:wallet -w @phoenix/dashboard` | **PASS**, 4/4. |
| `npm run test:evidence -w @phoenix/dashboard`; `npm run test:transitions -w @phoenix/dashboard` | **PASS**. |
| `bash scripts/build-near.sh` | **PASS**, Core and REWIND artifacts built and import-audited: 15 and 25 reviewed imports. |
| `npm run build -w @phoenix/dashboard` | **PASS**, production build and static route generation. |
| `node scripts/test-phase7-backend-api.mjs` (after backend build) | **PASS**, actual `/api/demo` handler returned `202`/`200`; final state `succeeded`, exit code 0, 12 events, and independently reverified receipt. |

Reproduction for the unified contract/service case:

```sh
bash scripts/build-near.sh
cargo build --offline --locked --manifest-path services/recovery/Cargo.toml --bin phoenix-worker
cargo test --offline --locked --manifest-path integration-tests/Cargo.toml phase7_unified_sandbox_recovery_receipt_and_guardian_fail_closed -- --nocapture --test-threads=1
```

Reproduction for the backend receipt parser and its missing/invalid/replayed/mismatched cases:

```sh
npm test -w @phoenix/backend
```

To run the real Phase 7 example through the backend API success gate (requires local Sandbox socket access):

```sh
npm run build -w @phoenix/backend
node scripts/test-phase7-backend-api.mjs
```

### Changed files and remaining work

Phase 7B changed only these implementation/documentation files:

- `apps/backend/package.json`
- `apps/backend/src/control-plane.test.ts`
- `apps/backend/src/demo.ts`
- `apps/backend/src/recovery-proof.ts`
- `apps/backend/src/recovery-proof.test.ts`
- `integration-tests/examples/phase7.rs`
- `integration-tests/src/lib.rs`
- `integration-tests/src/recovery_sandbox.rs`
- `integration-tests/src/sandbox_adapter.rs`
- `scripts/test-phase7-backend-api.mjs`
- `docs/PHASE7B-E2E-EVIDENCE.json`
- `docs/PHASE7-INTEGRATION-REPORT.md`

No smart contracts, dashboard components, CSS, wallet authorization, or frontend design files were modified.

Remaining limitations and prioritized follow-up:

1. **P1 — Production adapter is not implemented.** `services/recovery/src/coordinator.rs`, `services/recovery/src/guardian.rs`, and a new `services/recovery/src/near_adapter.rs` (or equivalent) still need concrete finalized-RPC and transaction-signing adapters with signer separation, idempotent retries, and restart/reconciliation behavior. Current implementations are local sandbox adapters and service mocks.
2. **P1 — Independent backend chain query and durable replay history are unavailable after a demo.** The backend validates a receipt signed by its pinned test SENTINEL key and checks all included evidence, while the local Rust runner confirms that Core stored it. Receipt signatures are replay-protected for the lifetime of the backend process; this replay set is not persisted across backend restarts. The ephemeral sandbox terminates with the example, so the backend cannot subsequently re-query that deployment; durable/testnet operations need persistent proof storage, local RPC, and independently pinned contract/account configuration.
3. **P2 — Browser-level verification remains open.** Dashboard build and tests pass and UI files are untouched, but there is no Playwright/browser console test for hydration or client rendering of the same backend event IDs.
4. **P2 — Permanently missing REWIND callback remains a liveness limitation.** A real failed transfer callback and refund path pass in the existing sandbox suite; permanent callback loss and an operational reconciliation flow are not implemented.

No security-sensitive contract change was indicated by these results. No public network or real-fund action was performed.
