# Test evidence and current verification status

This document preserves earlier validation history. The fresh Grand Prize
release-candidate run from Nov 9, 2026 is summarized first; see
[the release report](GRAND-PRIZE-RELEASE-REPORT.md) for the complete matrix,
scope and publication blockers. Earlier milestone results below are historical
and may have older counts or environment details.

## Grand Prize release-candidate validation (2026-11-09)

| Check | Current result |
| --- | --- |
| Rust formatting | **Passed** for root contracts, recovery service and integration crate. |
| PHOENIX Core and REWIND contract tests | **145 passed** (Core 53, REWIND 92). |
| Recovery service and worker tests | **57 passed** (56 service/security, 1 worker process). |
| Backend receipt verification and replay tests | **Passed**; all 5 configured Node test files (37 cases) passed. |
| Backend/dashboard TypeScript | **Passed**. |
| Dashboard wallet, evidence and recovery-transition tests | **Passed**; wallet suite 4/4. |
| NEAR Sandbox integration | **5/5 passed** using ephemeral local contracts/accounts; the Nov 9 full-script run took 102.95 seconds. |
| NEAR WASM build/import audit | **Passed**; Core 278,665 bytes and REWIND 237,980 bytes; 15 and 25 reviewed imports. |
| Dashboard production build | **Passed**; 13 static routes generated. |
| Phase 8B evidence classification tests | **5/5 passed**; these are offline consistency/tampering tests, not cryptographic NEAR proof verification. |
| Dependency audit | **Passed**, 0 npm audit findings across 70 resolved packages in the fresh registry audit. |
| Unified demo and receipt | **Passed**; `POST /api/demo` 202, final `succeeded`, exit 0, 12 Sandbox events, one settlement and one backend-verified signed receipt. |
| Secret-pattern scan | **No matches** in current text files or the 2 reachable Git snapshots; scanner scope and limits are in the release report. |
| Browser/hydration verification | **Blocked**; cached Chromium cannot start because `libnspr4`, `libnss3` and `libasound2` are missing; package install requires root access. |

The exact combined validation command is `CARGO_NET_OFFLINE=true bash
scripts/test-phase6.sh`. It passed when the test process had permission to open
the local Sandbox sockets; a restricted run without that permission fails before
scenario setup. A second end-to-end run via `npm run demo:local` also completed
successfully with 12 events, one settlement and one receipt. The fresh artifact
is `/tmp/near-phoenix-phase7b-demo-20261109T095720Z-3129884.json`. The receipt
is based on the ephemeral Sandbox
scenario and backend checks; it is not evidence of public-network deployment or
an independently verified NEAR receipt proof. The [release report](GRAND-PRIZE-RELEASE-REPORT.md)
records the evidence path, scope, current Git state and publication blockers.

## Stage F validation run (historical: 2026-11-05)

These checks ran after the Stage F dashboard and documentation changes.

| Check | Result |
| --- | --- |
| Dashboard evidence-metric unit tests | **Passed** |
| Dashboard wallet-session tests | **4 passed, 0 failed** |
| Backend build and test files | **4 test files passed, 0 failed** |
| Workspace TypeScript checks | **Passed** |
| Next.js production build | **Passed**; static `/` and `/_not-found` routes generated |
| PHOENIX Core and REWIND Rust tests | **145 passed** (53 Core, 92 REWIND) |
| Recovery service tests | **57 passed** (56 unit, 1 worker-process) |
| Rust formatting checks | **Passed** for workspace, recovery service and integration crate |
| NEAR WASM build and import inspection | **Passed**; Core 278,665 bytes / 15 imports; REWIND 237,980 bytes / 25 imports |
| Sandbox integration crate compilation | **Passed** |
| NEAR sandbox integration runtime | **Blocked: 0 passed, 5 failed before scenario setup**, all with `Error while creating a socket` |

The sandbox failures are host socket restrictions, not successful scenario
assertions. Re-run in normal Ubuntu using the commands below before relying on
runtime evidence for this revision. No contracts were deployed publicly and no
real funds were used.

## Phase 6 baseline results (historical)

| Check | Result |
| --- | --- |
| Root, recovery-service and integration Rust formatting checks | **Passed** |
| PHOENIX Core unit tests | **42 passed, 0 failed** |
| REWIND unit tests | **92 passed, 0 failed** |
| Recovery / STATEFLOW / SENTINEL / GUARDIAN unit tests | **45 passed, 0 failed** |
| Worker subprocess crash/recovery test | **1 passed, 0 failed** |
| Rust total | **180 passed** across the contract and recovery workspaces; integration sandbox tests are not in this count |
| Backend unit/integration test cases | **15 passed** (three Node test files) |
| Backend and dashboard TypeScript checks | **Passed** |
| Recovery worker build | **Passed** |
| PHOENIX and REWIND cargo-near WASM builds | **Passed**; import audit passed for 15 Core and 25 REWIND imports |
| Integration-test crate compilation | **Passed** |
| NEAR sandbox integration runtime | **Blocked: 0 passed, 4 failed before setup** because sandbox startup could not create a local socket (`Operation not permitted`) |
| Next.js production build | **Blocked after successful app compilation**; Next could not parse empty child-process output from `tsc --showConfig`. The standalone dashboard `tsc --noEmit` check passed. |

The WASM artifacts were 230,812 bytes (Core; SHA-256
`cb5f2bf53c85029aca39f30409fb99d5b8a8ad21fa9c4fa005f94a425a129e5f`) and 237,911
bytes (REWIND; SHA-256
`eae8f822afb3256adea6c4cc69776c10025780c4083db086a7e74f6b26f50a5b`). The
current import/export report is [near-wasm-manifest.json](../artifacts/near-wasm-manifest.json).
An import audit is not a sandbox execution or reproducible-build attestation.

## Earlier demo evidence

Before Phase 6, the project owner reported that the Phase 5 local demonstration
completed with **12 verified events** and passing sandbox assertions. The owner
also reported that all four Phase 4 sandbox tests passed. Those are user-reported
prior results, not a successful rerun of the Phase 6 additions in this execution
environment.

The Phase 6 test run compiled the four integration tests but could not start any
sandbox node. The new on-chain expired-approval and quarantine-bypass assertions
therefore need a runtime rerun in a normal Ubuntu terminal before describing them
as passed. Use the exact commands below:

```sh
cd /path/to/near-phoenix
bash scripts/build-near.sh
cargo test --manifest-path integration-tests/Cargo.toml --locked -- --nocapture
```

The current execution environment also prevents Node child processes from
delivering captured `tsc --showConfig` output to Next.js. A direct dashboard
TypeScript check passes, but run the production build on the hackathon workstation:

```sh
npm ci
npm run build -w @phoenix/dashboard
```

For the complete repeatable validation attempt, run `bash scripts/test-phase6.sh`.
It reports environment failures rather than treating them as passes.

## Coverage map

Existing unit tests cover forged/expired/replayed signatures and approvals,
unauthorized payment/refund/withdrawal attempts, duplicate settlements and
callbacks, refunds racing reserved or pending transfers, failed/uncertain
transfer callbacks, checkpoint tampering/rollback/forks, stale recovery epochs,
conflicting recovery approvals, quarantine bypass, audit-chain tampering and
recovery/service restarts. Backend tests cover origin rejection, CORS preflight,
polling, demo event requirements, audit verification and stopping the child on a
backend restart.

The integration source adds contract-level coverage for expired approvals,
forged approvals, unauthorized settlement, one-time operation IDs, real native
transfer failure callbacks, refund-vs-pending exclusion, unauthorized
quarantine release, and the primary crash/backup restoration/exactly-once flow.
Runtime results for that source must be collected on a machine where the sandbox
can bind local sockets.

## Data provenance and metrics

The Mission Control dashboard applies these scope rules:

| Metric | Source and method | Scope / unavailable condition |
| --- | --- | --- |
| Recovery latency | Timestamp difference between a returned `primary_failed` event and a later `backup_restored` event. | One local demo run only; absent, invalid or unpaired timestamps yield “Unavailable.” Not a service-level statistic. |
| Recovery success rate | Not calculated. | The API does not provide a complete attempt denominator with terminal outcomes. A current epoch or latest receipt is insufficient. |
| Duplicate-payment prevention | Count of returned `duplicate_payment_prevented` demo events. | Local sandbox demo only; counts event evidence, not a lifetime or mainnet total. |
| Authorization failures | Matching rejection kinds in GUARDIAN records accepted after signature and audit-head verification. | Only the returned anchored history. If it is unavailable/unverified, the dashboard reports “Unavailable.” |
| Security incidents | Quarantine decisions in that same verified GUARDIAN history. | Only returned history; not a global incident rate or an AI prediction. |

Contract panels are finalized RPC observations for configured accounts. The backend
does not independently prove RPC honesty or derive global history. Receipt
settlement evidence is checked by the trusted observer and signed/recorded under
the contract's configured SENTINEL authority; the contract cannot synchronously
query REWIND. Sandbox event data is separate from testnet/mainnet RPC evidence.

For repeatable Stage F checks, run from the repository root:

```sh
npm run test:evidence -w @phoenix/dashboard
npm run test:wallet -w @phoenix/dashboard
npm test -w @phoenix/backend
npm run typecheck
npm run build -w @phoenix/dashboard
cargo test --workspace --locked
cargo test --manifest-path services/recovery/Cargo.toml --locked
bash scripts/build-near.sh
cargo test --manifest-path integration-tests/Cargo.toml --locked -- --nocapture
```
