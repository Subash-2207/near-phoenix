# NEAR PHOENIX v5.0 — Phase 8 Security Report

**Review date:** 2026-11-09<br>
**Scope:** Backend, recovery service, Core/REWIND behavior, Sandbox integration, dashboard dependency tree and API boundaries.<br>
**Safety:** No contracts or frontend appearance were changed. All malicious-input and recovery execution tests ran against local fixtures or ephemeral NEAR Sandbox. No public network, mainnet or real funds were used.

## Executive result

The existing contract, recovery-service, and unified local Sandbox suites pass. The backend now persists accepted receipt signatures across process restarts, checks receipt validity against the latest observed Sandbox block timestamp, limits repeated local demo starts, tightens request validation, and avoids returning internal RPC/process errors to the dashboard. The dashboard TypeScript checks, tests, and production build pass.

**Production readiness: blocked.** The recovery service has no production chain adapter; the end-to-end demo depends on deterministic test-only Sentinel keys and trusts its child process to report Sandbox observations; the backend cannot independently query the ephemeral deployment after it exits. REWIND intentionally keeps an operation locked when its authentic callback never resolves. There is no safe reconciliation path for a callback that is permanently lost.

## Prioritized findings

| Priority | Severity | Finding | Evidence and impact |
|---|---|---|---|
| P1 | High | **No production recovery adapter or production signer boundary.** | `services/recovery/src/coordinator.rs` defines the required `Chain` and `Verifier` interfaces, but the concrete end-to-end chain implementation is the local Sandbox adapter in `integration-tests/src/sandbox_adapter.rs`. The backend RPC reader is read-only. No production finalized-RPC reader, transaction adapter, custody integration, or interruption/reconciliation supervisor exists. Do not enable autonomous production recovery. |
| P1 | High | **A permanently lost REWIND callback leaves escrow unresolved indefinitely.** | `contracts/rewind-vault/src/lib.rs` marks overdue operations `Uncertain`; only the private callback may resolve an operation from its authentic promise result. This preserves safety against double payment/refund, but there is no outcome source available to the contract if that callback never arrives. A timeout or owner override would be unsafe because timeout does not prove transfer failure. |
| P1 | High | **The backend receipt gate is Sandbox-specific, not an independent production verifier.** | The receipt key is pinned in `apps/backend/src/recovery-proof.ts`, while the matching deterministic seed (`[42; 32]`) is present in the test recovery scenario. The backend verifies the signature and binds it to the emitted evidence, but it receives `on_chain_verified`, the latest-block timestamp, and the rest of the event stream from its child process. It does not independently query a persistent deployment or verify the chain receipt after the process exits. Anyone with the repository can produce signatures using the test key. |
| P2 | Medium | **Local API requests are not authenticated.** | `apps/backend/src/index.ts` binds to loopback; `apps/backend/src/router.ts` requires the dashboard Origin and JSON for POSTs. CORS and Origin checks protect browser boundaries but are not authentication: another local process can forge the Origin header. Current server actions are local demo execution and unsigned wallet-transaction preparation, not server-side signing or broadcast. A production service needs authenticated operator sessions and per-principal authorization. |
| P2 | Medium | **Replay protection is durable only while its local ledger is retained.** | The new ledger survives backend restarts and coordinates concurrent processes on one filesystem. Deleting, restoring an older backup of, or failing to share the directory across hosts can make a prior receipt claimable again. It also grows with accepted receipts and has no cleanup policy, intentionally avoiding unsafe expiry-based deletion. A production deployment needs durable shared uniqueness storage with backup/restore controls. |
| P2 | Medium | **Guardian cannot isolate a compromised worker host.** | Contract quarantine, task pause, signed audit anchoring, and service fail-closed behavior pass tests. GUARDIAN does not terminate a worker, isolate its host, or revoke external infrastructure access. Host containment needs an authenticated production `WorkerHost`/supervisor integration. |
| P3 | Low | **No browser-level console/hydration verification was run in this phase.** | Dashboard TypeScript checks and the production build pass. The repository has no configured browser automation suite in the inspected test scripts, so a browser console pass is not claimed. |
| P3 | Informational | **No current npm advisory was reported for the installed lockfile.** | `npm audit --json` reported 0 known vulnerabilities across 70 dependency entries (26 production, 6 development, 39 optional). This is advisory-database evidence for the audit date, not a cryptographic review of the wallet connector. |

## Review of the requested controls

### Receipts and replay protection

- The receipt verifier checks the SENTINEL Ed25519 signature, canonical Borsh bytes, settlement evidence hash, deployment IDs, checkpoint, agent identities, epochs, recipient, amount, settlement reference, Guardian sequence, and required event ordering.
- It now also requires a valid receipt window at the workflow's latest observed Sandbox block timestamp. A host wall-clock check is unsuitable for this test: the recovery fixture deliberately advances Sandbox time by 2,000 blocks.
- Once the verifier accepts a receipt, `ReceiptReplayLedger` claims a SHA-256 digest of its signature using exclusive file creation, restrictive directory/file permissions, and file/directory fsync. A duplicate claim fails closed across restarts and concurrent local backend processes.
- The ledger is local state, not a distributed production replay database. The backend still cannot independently establish the current finalized chain state for an ephemeral deployment.

### REWIND callbacks and escrow

- Contract tests cover successful and failed native transfers, authentic delayed callbacks, duplicate callbacks, operation-ID tombstones, uncertain operations, and refund restrictions.
- A real failed transfer callback restores accounting in Sandbox. An unresolved operation remains locked and cannot be refunded or retried. This is the correct safety posture while delivery outcome is unknown.
- Permanent callback loss and a contract-level reconciliation action remain unimplemented. No contract code was changed.

### Recovery service, SENTINEL, GUARDIAN and fencing

- Sandbox and service tests cover independent approval checks, missing/forged/replayed authorization, backup eligibility, stale checkpoint rejection, monotonic epochs, duplicate execution/payment rejection, and fail-closed quarantine.
- The test harness uses deterministic identities and test-only adapter implementations. Independent production key custody and production RPC/transaction behavior are not demonstrated.
- The proof gate is intentionally limited to the Sandbox workflow (`network=sandbox`, epoch `0 -> 1`, demo nonce `2`). It must not be reused as a general production receipt verifier.

### Dependencies and wallet boundary

- The workspace package lock was audited without changing dependencies. The current dependency tree reports zero known npm advisories.
- This does not clear the external wallet connector or wallet signing path of independent security risk. No wallet transaction, key custody, mainnet action, or live account authorization was exercised in Phase 8.

### API validation and sensitive data

- Demo and preflight POST bodies are capped at 1 KiB. The demo accepts only the single `action=start` field. Oversized and extra-field inputs are rejected.
- The local Sandbox demo start endpoint now has a 30-second backend-process cooldown and returns `429` with `Retry-After` when limited. This is a local resource limit, not an authentication system or distributed quota.
- The read-only network/RPC routes do not have endpoint quotas. Before exposing them beyond a single local dashboard, add bounded per-principal request limits as well.
- Runtime RPC and child-process errors are mapped to generic API messages; the dashboard no longer receives internal stderr or filesystem/RPC error detail.
- The exact dashboard Origin, loopback listener and `application/json` requirement remain useful browser protections, but must not be described as API authentication.

## Changes made

- Added `apps/backend/src/receipt-replay.ts`: durable, fail-closed receipt signature claims under `PHOENIX_RECEIPT_REPLAY_DIR` or the user state directory.
- Updated `apps/backend/src/recovery-proof.ts` and `integration-tests/src/recovery_sandbox.rs`: compare receipt expiry to a timestamp read from the latest local Sandbox block.
- Updated `apps/backend/src/demo.ts`: success requires full receipt verification and a durable claim; child stderr and process errors are no longer exposed; close/finalization state prevents a second run while the receipt claim is being synced.
- Updated `apps/backend/src/router.ts`, `apps/backend/src/index.ts`, and `apps/backend/src/control-plane.ts`: body limits, strict demo action shape, a demo cooldown, and generic internal error responses.
- Added regression cases in `apps/backend/src/recovery-proof.test.ts`, `apps/backend/src/router.test.ts`, and `apps/backend/src/control-plane.test.ts` for receipt expiry, invalid/replayed/concurrent claims, unsafe ledger permissions, rate limits, malformed requests, and sensitive error suppression.
- Created this report.

No smart contract, wallet authorization, dashboard component, CSS, color, animation, layout, or design file was changed by Phase 8.

## Verification results

| Command | Result |
|---|---|
| `npm audit --json` | **PASS** — 0 reported vulnerabilities across 70 dependency entries. Initial sandbox DNS resolution failed; the authorized registry retry completed successfully. |
| `npm run typecheck --workspaces --if-present` | **PASS** — backend and dashboard. |
| `npm test -w @phoenix/backend` | **PASS** — all 5 backend test files; includes receipt replay, expiry, API validation/rate-limit and error-suppression regressions. |
| `cargo fmt --all --check` | **PASS**. |
| `cargo fmt --manifest-path services/recovery/Cargo.toml -- --check` | **PASS**. |
| `cargo fmt --manifest-path integration-tests/Cargo.toml -- --check` | **PASS**. |
| `cargo test --offline --locked --workspace` | **PASS** — 145 contract tests (PHOENIX Core 53; REWIND 92). |
| `cargo test --offline --locked --manifest-path services/recovery/Cargo.toml --target-dir services/recovery/target` | **PASS** — 57 tests (56 service/security and 1 real worker-process test). |
| `cargo build --offline --locked --manifest-path services/recovery/Cargo.toml --target-dir services/recovery/target --bin phoenix-worker` | **PASS**. |
| `cargo check --offline --locked --manifest-path integration-tests/Cargo.toml --tests --examples` | **PASS**. |
| `cargo test --offline --locked --manifest-path integration-tests/Cargo.toml -- --nocapture --test-threads=1` | **PASS** — 5/5 ephemeral local Sandbox tests, including the unified recovery/receipt/Guardian workflow. |
| `bash scripts/build-near.sh` | **PASS** — Core and REWIND WASM builds and import audit; 15 and 25 reviewed imports. |
| `npm run test:wallet -w @phoenix/dashboard` | **PASS** — 4/4. |
| `npm run test:evidence -w @phoenix/dashboard` | **PASS**. |
| `npm run test:transitions -w @phoenix/dashboard` | **PASS**. |
| `npm run build -w @phoenix/dashboard` | **PASS** — optimized production build and static route generation. |
| `PHOENIX_RECEIPT_REPLAY_DIR=/tmp/phase8-receipt-ledger-final node scripts/test-phase7-backend-api.mjs` | **PASS** — POST 202; GET 200; final `succeeded`, exit code 0, 12 events and a verified receipt. The script rewrote the Phase 7 evidence artifact during the test; its exact pre-test contents were restored afterward. |

The initial API smoke attempt failed because it compared Sandbox time to host wall time. That check was replaced with the latest observed Sandbox block timestamp; the smoke test then passed. No test failure remains unresolved.

## Remaining risks and production-readiness blockers

1. Implement and independently review a production `Chain`/`Verifier`/`SecurityChain` adapter with finalized reads, role-separated transaction signers, explicit idempotency, bounded retries, interruption recovery, and operational supervision. Keep mainnet disabled until separately approved and tested.
2. Add a persistent deployment configuration and backend verification path that independently queries the configured finalized chain and validates the stored Core receipt and REWIND operation. Do not trust a child process's `on_chain_verified` field as production evidence.
3. Decide how to reconcile an operation when the REWIND callback is permanently lost. The present contract cannot distinguish a successful transfer from a failed transfer without the authentic callback result. Do not add timeout-based refund or unilateral administrator outcome override.
4. Replace local-file replay storage with durable shared uniqueness storage before running multiple production instances; define backup, restore, access-control, retention, and incident procedures.
5. Add authenticated operator API sessions, authorization per operation, and distributed rate limits before exposing the API beyond the local workstation.
6. Complete production wallet/dependency review and a browser E2E run that checks the dashboard console and hydration behavior.

## Contract-change approval boundary

I made no contract changes. Before changing escrow settlement or authorization, the proposed next step is a design review for a reconciliation protocol that preserves the current locked `Uncertain` state and requires independently authorized, finalized evidence. NEAR contracts cannot inspect a lost historical callback result directly; an off-chain attestation would introduce a new trust source, while a unilateral owner override could wrongly release funds after a successful transfer. **Approval is required for the trust model and exact authorization roles before implementing any such contract path.**
