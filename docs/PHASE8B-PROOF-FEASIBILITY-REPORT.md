# NEAR PHOENIX v5.0 — Phase 8B Proof Feasibility Report

**Date:** 2026-11-09
**Scope:** Read-only, local proof-feasibility review for REWIND settlement evidence
**Recommendation:** **NO-GO for reconciliation implementation**
**Security boundary:** No contract, settlement, authorization, wallet, balance, or UI changes were made. No transaction was signed or submitted in this phase. No public RPC or mainnet was used.

## Executive result

The saved Phase 7B local Sandbox run contains internally consistent settlement claims for one payment, but it does not contain the transaction hash, transfer receipt ID, receipt input, execution-outcome proof, or finalized-header proof needed to independently authenticate that settlement. The saved `on_chain_verified` flag and SENTINEL signature authenticate a project recovery-receipt claim under the Phase 7 test setup; they are not NEAR consensus or receipt proofs.

The read-only status query to `127.0.0.1:3030` found no running Sandbox RPC. Re-running the original end-to-end Sandbox scenario would sign and submit local transactions, which this phase explicitly prohibited. Therefore this review used the checked-in Sandbox evidence artifact and did not claim to query or cryptographically verify a live chain transaction.

**Conclusion:** Operation-to-recipient/amount/outcome claims can be cross-checked within the saved artifact, and automated tamper checks pass. Receipt identity, receipt causality, exact transfer input, finalized outcome, and NEAR proof replay resistance remain **unverified**. Do not implement REWIND reconciliation based on this evidence. Keep uncertain funds locked.

## Scope and method

Read `docs/PHASE8-REWIND-RECONCILIATION-DESIGN.md` first. Inspected the Phase 7B artifact, the Sandbox recovery test/adapter, REWIND transfer/callback code, and NEAR RPC/proof documentation. Added an isolated Node test that checks the saved artifact’s internal claim consistency and ensures that self-reported fields or proof-shaped placeholders never become a cryptographic verification result.

The approved limits were observed:

- Used only the already saved local Sandbox artifact at `docs/PHASE7B-E2E-EVIDENCE.json`.
- Attempted only a read-only `status` query at `http://127.0.0.1:3030`; it returned connection refused because no Sandbox process was listening.
- Did not run the existing Sandbox workflow, which creates accounts, deploys contracts, and signs local transactions.
- Did not sign or broadcast transactions, query a public network, deploy contracts, or move funds.

## Evidence inventory

The prior Sandbox artifact reports the following settlement claim:

| Field | Saved value | Evidence classification |
|---|---|---|
| Operation ID | `0b3db2802b313a786e64c56b546a91d55d8d6c2870a35e0eb0029cdcc866d93f` | Present in runner event and signed recovery-receipt body |
| REWIND task | `recovery-task` | Runner and receipt claim |
| Recipient | `dev-20261109062537-65345800287645.test.near` | Runner and receipt claim |
| Amount | `1000000000000000000000000` yoctoNEAR (1 NEAR) | Runner and receipt claim |
| Settlement epoch | `1` | Runner and receipt claim |
| Settlement outcome | Runner event `Paid`; receipt evidence `Succeeded` | Claims agree under the test’s mapping |
| Settlement block | Height `2181`, hash `J6cXjT3bCMxHuz7sxNMd3LUMgSPmt4PjFWjZWtUdosww` | Reported by the Sandbox test harness; raw block/proof response absent |
| Duplicate protection | Same operation ID and a reported recipient balance delta of exactly the amount | Prior test-harness event; not an independently verified receipt proof |
| Transaction hash | Not present | Missing |
| REWIND execution receipt ID / transfer receipt ID | Not present | Missing |
| Receipt input and transfer action proof | Not present | Missing |
| Receipt execution outcome plus outcome-root proof | Not present | Missing |
| Finality proof / validator path / trusted Sandbox checkpoint | Not present | Missing |
| Cryptographic REWIND operation-state proof and deployed code hash at the relevant state | Not present in the settlement proof material | Missing |

The prior integration code does make actual Sandbox calls and reads finalized state, but the saved artifact contains the test runner’s derived events, not the raw signed transaction, RPC receipt trace, or proof bundle. A block height/hash and a SHA-256 evidence digest are identifiers/commitments; without their inputs and authenticated proof paths, they do not independently prove canonical chain state.

## What was and was not verified

| Property | Result | Explanation |
|---|---|---|
| Operation ID matches receipt settlement reference | **Consistent claim** | The artifact fields match. No NEAR proof ties that operation ID to the transfer receipt. |
| Intended recipient and amount match | **Consistent claim** | Runner event, receipt evidence, paid amount, and reported balance delta agree. No receipt input proof authenticates transfer destination/amount. |
| Settlement outcome | **Reported success only** | Runner reports `Paid`/`Succeeded`; no independently checked transfer execution outcome is included. |
| Causality from REWIND call to native transfer receipt | **Not verified** | Transaction hash and parent execution receipt/outgoing receipt IDs are missing. |
| Receipt identity | **Not verified** | No transfer receipt ID or serialized receipt is present. |
| Finality | **Not independently verified** | A harness-reported block hash/height is present. No raw `tx_status FINAL` response, finality proof, or authenticated header chain is present. |
| Mismatch resistance | **Artifact consistency only** | Tests reject altered operation, recipient, amount, block height, and duplicate event claims. They do not validate NEAR cryptographic proofs. |
| Replay resistance | **Partially exercised at the claim layer** | A duplicated event claim is rejected by the offline audit. No receipt/proof identifier exists to test cryptographic replay across operations, networks, or deployments. |
| Transaction outcome proof verification | **Not implemented** | The prototype intentionally contains no NEAR proof parser, Merkle verifier, or consensus light-client verifier. |

## RPC observations versus cryptographic proofs

NEAR’s transaction RPC documents `tx_status` as returning a receipt list and `FINAL` as waiting for all receipts, including refunds. It also documents that receipt lists can be incomplete when receipts have not executed or a node does not track the relevant shard. A `FINAL` response is a useful RPC observation, but a client must still validate the returned proof material and finality if it wants independence from that RPC provider. [NEAR transaction RPC documentation](https://docs.near.org/api/rpc/transactions)

The documented `light_client_proof` response contains block-header-lite data, block and outcome proof fields, and an outcome-root proof; its request and description are for a transaction execution proof. NEAR’s protocol proof guide describes receipt execution outcomes committed under chunk outcome roots and Merkle paths, while warning that proof siblings do not themselves supply the outcome root or receipt hash. These are relevant building blocks, but this review did not obtain or verify a proof bundle for the project’s transfer receipt, prove its action input, or authenticate a finalized block from a pinned Sandbox checkpoint. [NEAR light-client proof API](https://docs.near.org/api-reference/post-light_client_proof), [nearcore proof guide](https://github.com/near/nearcore/blob/master/docs/architecture/how/proofs.md)

In this project, the backend’s `network.ts` explicitly returns `cryptographicProof: false` for transaction observations. The existing integration test’s finalized reads and balance comparison are genuine Sandbox observations in the previous test run, but the saved artifact does not let this Phase 8B prototype independently reproduce those reads or verify their proofs.

## Automated tests

Added `scripts/phase8b-proof-feasibility.test.mjs`. It is an offline audit of the existing Phase 7B artifact, not a chain client or proof verifier.

Command:

```sh
node scripts/phase8b-proof-feasibility.test.mjs
```

Result: **PASS — 5/5 tests**.

| Case | Result |
|---|---|
| Saved Sandbox settlement claims agree internally | **PASS** |
| Altered amount, recipient, operation ID, or settlement block is rejected | **PASS** |
| Duplicate settlement/receipt event claims are rejected | **PASS** |
| Self-reported `on_chain_verified`, signature, or caller-supplied proof-shaped fields do not become cryptographic verification | **PASS** |
| Current artifact is recognized as missing transaction, receipt, causal-link, and finality proof parts | **PASS** |

The tests do **not** establish positive NEAR cryptographic verification. The positive case means only that the saved claims are mutually consistent. No Cargo/Sandbox test was run in this phase because the only existing Sandbox test path submits signed transactions and no Sandbox process/evidence database was available for read-only RPC queries.

Read-only RPC availability check:

```sh
curl --max-time 2 -sS -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":"phase8b-readonly","method":"status","params":{}}' http://127.0.0.1:3030
```

Result: **UNAVAILABLE** — connection refused on `127.0.0.1:3030`; no Sandbox process was listening. No transaction method was called.

## Unsupported or missing proof features

The project currently has no implemented verifier for:

1. Transaction and receipt IDs linked to the recorded REWIND operation.
2. The parent REWIND execution outcome and its child receipt IDs.
3. Receipt input/inclusion showing the exact native transfer sender, receiver, and amount.
4. Transfer receipt execution outcome and its Merkle path to a chunk outcome root.
5. Inclusion/authentication of the relevant chunk/header under a finalized block.
6. Validation of finalized headers from a pinned Sandbox genesis/checkpoint and correct validator set.
7. A state proof binding REWIND operation terms and reviewed code hash to the relevant finalized state.
8. Persistent proof/replay identity checks for proof submissions across operation, contract, chain, and deployment domains.

An RPC transaction status response, indexer event, balance delta, sentinel signature, backend `on_chain_verified` boolean, or manually supplied Merkle siblings must not be accepted as a substitute for these checks. The hash path must be recomputed from canonical NEAR-serialized inputs and rooted in an independently authenticated finalized header.

## Trust assumptions and security notes

- The Phase 7B artifact is accepted here as a saved output of the prior local test run. This Phase 8B review did not authenticate the file against a chain or reproduce the run.
- The previous Sandbox runner and its near-workspaces RPC/client were trusted to have produced the recorded event values. This is an observation trust assumption, not proof verification.
- The SENTINEL key/signature and receipt cover a project-specific recovery receipt. They do not independently attest NEAR consensus finality and are not proof of the REWIND transfer receipt’s action input.
- A malicious or faulty RPC can misreport transaction status or omit relevant shards/receipts. Missing, timed-out, incomplete, or contradictory evidence must remain `Uncertain`.
- A valid outcome Merkle path under a caller-selected root does not prove canonicality. Finality authentication requires a pinned chain identity/checkpoint and validated consensus/header transition proof.
- There was no evidence in this phase of a smart-contract authorization defect because no contract behavior was exercised or changed.

## Recommendation and next steps

### Decision: NO-GO

Do **not** implement REWIND lost-callback reconciliation from the current evidence. There is no independent proof that the exact transfer receipt for the recorded operation succeeded or failed, and no tested implementation that verifies receipt linkage and finality. Keep all uncertain funds locked.

### Safe next steps

1. Preserve this artifact’s classification as Sandbox-runner/RPC-reported evidence; do not relabel it as cryptographically verified.
2. If raw evidence from the earlier Sandbox run is available, archive the transaction hash, sender, raw `tx_status FINAL` payload, receipt IDs and inputs, all receipt outcomes, block/chunk data, and proof fields. An independent verifier can then assess whether it is complete without signing another transaction.
3. If that raw evidence is unavailable, obtain separate approval for a future **Sandbox-only transaction-generation step**. That step would need local signing to produce reproducible fresh evidence, which was explicitly out of scope here.
4. Before any reconciliation implementation, build an independent local verifier for the complete causal and finality chain and adversarial proof tests. A failed or unsupported proof must leave REWIND unchanged and funds locked.
5. Request separate approval before any contract settlement, authorization, wallet permission, or other security-sensitive change.

## Files changed in Phase 8B

- Added `scripts/phase8b-proof-feasibility.test.mjs` — offline claim-consistency and fail-closed classification tests.
- Added this report.

No contract, balance, settlement logic, authorization, wallet permission, or frontend/UI file was changed.
