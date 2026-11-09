# NEAR PHOENIX v5.0 — REWIND Lost-Callback Reconciliation

**Status:** Design review only; no implementation authorized or performed
**Review date:** 2026-11-09
**Scope:** REWIND escrow operations whose transfer outcome callback does not update contract state
**Safety boundary:** Uncertain principal stays locked. No timeout, RPC response, signature, or other off-chain claim alone may settle, refund, release, or reassign it.

## 1. Decision summary

REWIND currently has the right fail-safe default: a transfer that times out becomes `Uncertain`, stays in pending accounting, cannot be retried under the same operation, and blocks task refund while unresolved. Only the private `on_transfer` callback consumes the promise result and resolves the operation. This preserves principal at the cost of potentially locking funds indefinitely.

NEAR execution evidence can, in principle, establish that a particular transfer receipt succeeded or failed without trusting a single RPC provider. NEAR exposes execution outcomes and Merkle proofs, and its protocol documentation describes proof paths to receipt outcome roots. That is not sufficient by itself: a reconciler must also authenticate finalized consensus, prove the exact receipt was the transfer created for this REWIND operation, and bind its receiver and amount to immutable operation terms. The current REWIND state does not store the generated receipt ID or a proof-verifiable receipt link. The RPC endpoint documented as `light_client_proof` is described for transaction execution; it is not a ready-made, contract-verifiable solution for this complete receipt lineage.

**Recommendation:** Keep the existing permanent-lock behavior as the production rule until a proof-verification prototype demonstrates the complete evidence chain. The target architecture should accept a permissionless proof submission only after a verifier authenticates a finalized NEAR outcome and its causal link to the exact REWIND operation. A separate, threshold authorization step must approve any accounting transition; the proof itself determines success/failure, while independent authorization permits the state change. If proof verification, receipt linkage, finality, or authorization is incomplete or ambiguous, leave the operation `Uncertain` and funds locked. Do not build an administrator outcome override or RPC-only reconciliation path.

This is a design recommendation, not approval to modify contracts, settlement logic, authorization rules, or wallet permissions. A working proof verifier and a contract authorization change each require separate review and approval before implementation.

## 2. Current implementation findings

Reviewed `contracts/rewind-vault/src/lib.rs` and the Phase 8 and Phase 7 integration reports.

- `OperationState` includes `Pending`, `Uncertain`, `Succeeded`, and `Failed`. Operations are stored by ID and IDs are permanent tombstones.
- `begin_transfer` records the pending operation and accounting before scheduling the transfer and private callback. The callback receives only the operation ID; it uses the NEAR promise result as the outcome source.
- `mark_uncertain` changes an overdue `Pending` operation to `Uncertain`; the one-hour timeout is a liveness alarm, not proof of transfer failure.
- `on_transfer` is private, requires exactly one promise result, and resolves only `Pending` or `Uncertain`. An unexpected promise result preserves `Uncertain`.
- A successful callback accounts the transfer as paid/refunded. A failed callback restores the amount to internal available accounting. It does not prove that an external RPC observation is safe to treat as that callback result.
- Refund is blocked while task reservations or pending principal remain. Thus unresolved operations intentionally prevent a task refund.
- The operation stores task, recipient, amount, kind, commitment, approval revision, and execution epoch, but not a transfer receipt ID, originating receipt ID, block proof, or reconciliation record.
- Current contract tests cover authentic delayed callback handling and uncertain-state locking. The Phase 7 Sandbox suite exercises successful and failed callback paths; the report does not claim a permanently lost callback integration test.
- `apps/backend/src/network.ts` reports RPC transaction/receipt observations as `cryptographicProof: false`. The Phase 8 report also says the current backend has no production chain adapter and cannot independently validate a permanent deployment’s receipt state.

The key distinction is between **a transfer that is still pending**, **a transfer whose outcome is known on chain but the REWIND callback did not update storage**, and **a transfer for which the observer cannot retrieve enough data**. A provider timeout, incomplete receipt list, unsupported shard, pruned history, or unavailable proof is not evidence of failure.

## 3. What finalized on-chain state can establish

NEAR `tx_status` can return receipt details. Its documented `FINAL` wait level waits for finalization of all receipts, including refunds; `EXECUTED` waits for finalized non-refund receipts. The same documentation warns that a `tx_status` receipt list can be incomplete when receipts have not run yet or when the node does not track the relevant shard. Therefore a partial response, timeout, `DOES_NOT_TRACK_SHARD`, or RPC error must fail closed. See the [NEAR transaction RPC documentation](https://docs.near.org/api/rpc/transactions).

NEAR’s protocol proof guide describes receipt execution outcomes committed under chunk outcome roots and Merkle paths that can be verified against those roots. The light-client proof API returns an execution outcome and proof fields, but documents its request as a transaction execution proof. The proof guide also explains that returned proof siblings alone do not contain the outcome root or receipt hash. These sources support feasibility of proof-based verification, but do not supply this project with a ready-made proof that binds a finalized transfer receipt’s input (sender, receiver, transfer amount and causal origin) to a REWIND operation. See [nearcore’s proof guide](https://github.com/near/nearcore/blob/master/docs/architecture/how/proofs.md) and the [NEAR light-client proof API](https://docs.near.org/api-reference/post-light_client_proof).

### Evidence required for a conclusive outcome

A future verifier must demonstrate all of the following, using an independently verifiable proof bundle rather than trusting the RPC response fields:

1. **Network and contract identity:** correct chain/genesis, REWIND account ID, reviewed code hash/version, and operation ID.
2. **Immutable operation terms:** proof or authenticated state observation for the exact task, operation, kind, amount, recipient, and issued execution epoch. A provider’s unproven JSON view is not enough for a contract decision.
3. **Causal link:** prove that the transfer receipt was emitted by the specific REWIND execution that marked this operation pending. The link must be unambiguous if a source execution emitted multiple receipts.
4. **Receipt contents:** prove that the linked receipt is a native transfer from the REWIND account to the operation’s stored recipient for exactly the stored amount. An execution outcome generally reports the outcome, not all action inputs; receipt input/inclusion evidence must also be validated.
5. **Finalized execution outcome:** prove success or failure of that exact transfer receipt against a finalized NEAR block/chunk outcome root and authenticate the block’s finality using a reviewed trusted checkpoint and validator/finality rules. A bare Merkle path against a caller-supplied root is forgeable as a claim about canonical chain state.
6. **Outcome semantics:** success means the native transfer action succeeded. Failure means that exact transfer action failed. “No receipt found,” “unknown,” an unresolved dependency, RPC timeout, or absent callback is not a failure outcome.
7. **Settlement safety:** prove that the operation remains `Uncertain`, has not already been reconciled, and that its task accounting still satisfies the contract invariants at the state transition point.

The proof bundle should include the transaction/receipt identifiers, outcome block hash and height, block/chunk/header proof material, receipt input and execution-outcome proofs, and an immutable digest of all operation terms. The verifier must be tested against pinned protocol versions and network-specific genesis/checkpoint data. RPC providers can transport proof material, but must not be trusted to assert that it is valid.

**Feasibility gate:** Before proposing a contract change, build a read-only local verifier prototype that validates actual Sandbox proof bundles for both successful and failed transfers and proves the complete causal link. Measure proof size, computation/gas, storage, protocol-version compatibility, and recovery behavior across validator-set/epoch changes. If any part depends on an unverified provider statement, the proof does not qualify for automatic contract reconciliation.

## 4. Trust model and authorization boundaries

### Trusted assumptions

- NEAR consensus/finality and the verifier’s correctly pinned chain genesis, protocol rules, and validator transitions.
- The deployed REWIND code hash and its established accounting invariants.
- Cryptographic hash/signature implementations and the correctness of the proof verifier.
- Distinct authorization principals and their key custody, if a proof-authorized reconciliation transition is enabled.

### Untrusted inputs

- RPC and indexer responses, event logs, dashboards, backend claims, operator explanations, screenshots, and child-process output.
- Submitted IDs, amounts, receipt IDs, proof bytes, block headers, execution statuses, and claimed epochs until independently verified.
- A single “reconciler” service or any one SENTINEL/Guardian signature as evidence of the transfer outcome.

### Separation of duties

- **Proof establishes outcome; signatures do not.** Independent authorization must not convert an unverified off-chain claim into a transfer result.
- A candidate policy is a threshold of at least two distinct principals for the state-changing reconciliation action, chosen from task verifier, depositor/treasury authority, and an independently governed SENTINEL recovery quorum. The executor that initiated the payment cannot satisfy the threshold alone. The exact policy must be reviewed against existing deployment roles before implementation.
- **GUARDIAN is a hold/veto boundary.** Safe mode, task pause, quarantine, or a changed security revision must block reconciliation and invalidate stale approvals. Guardian must not be able to declare transfer success/failure unilaterally.
- **SENTINEL approves the exact digest.** Approval must bind chain ID/genesis, contract/code hash, operation/task IDs, operation terms, immutable issued epoch, outcome, proof hash, nonce, approval revision, and expiry. SENTINEL authorization is not a substitute for proof verification.
- Any mandatory signer outage, signer-role overlap, proof-verifier outage, disagreement, or unsupported protocol state leaves funds locked.

### Fencing and one-time use

- Bind the proof and all approvals to the operation’s immutable execution epoch and security revision. Never accept an epoch supplied only by the caller.
- A prior-epoch operation may need accounting closure after a takeover, but resolving its old outcome must never authorize it to execute again or make its budget spendable by a stale agent. If the current task epoch has advanced, any returned amount should remain quarantined until a separately authorized current-epoch allocation is defined.
- Use the existing permanent operation ID as a tombstone and add a permanent on-chain reconciliation marker/proof digest if this design is implemented. A database-only replay ledger is not adequate for fund safety.
- Consume a unique nonce/reconciliation version atomically with the state transition. Reject replays across operation IDs, tasks, chains, deployments, code versions, outcomes, proof hashes, epochs, and approval revisions.
- Validate terminal state and accounting under the same contract call. Duplicate callbacks, proof submissions, or races must not decrement liability or pending twice, restore available principal twice, or create a second transfer.

## 5. Design comparison

| Design | How it works | Trust assumption | Safety and liveness | Assessment |
|---|---|---|---|---|
| **A. Permanent lock (current behavior)** | Timeout marks `Uncertain`; only the authentic callback resolves it. Off-chain monitoring can report evidence but cannot mutate escrow. | NEAR’s normal promise execution and the existing callback code. No new outcome attestor. | Strongest current fund safety. A callback that never updates storage can lock principal indefinitely and block refund. | **Safest immediately. Keep as default and fallback.** No code changes needed. |
| **B. Quorum-attested operator reconciliation** | Independent watchers inspect finalized transaction/receipt data; a threshold of independent signers and existing role approvers authorizes an exact outcome digest. Contract verifies signatures, epoch, revision and one-time use. | Trusts the watcher quorum’s proof implementation, operations and signer independence. Multiple signatures reduce single-key risk, but the signer coalition could collude or share one faulty provider/parser. | Better liveness and simpler contract verification. Still not trustless; must not claim a single RPC JSON result is on-chain proof. Without a verified proof transcript, it can settle incorrectly. | **Not recommended for automatic fund mutation.** At most an explicitly governed manual exception after separate approval; no off-chain-evidence-only resolution. |
| **C. Proof-carrying reconciliation with on-chain verification** | Any relayer submits a proof bundle. A verifier authenticates finalized NEAR consensus, operation state, receipt input/causal link and exact transfer outcome. A separate threshold authorization then permits a one-time accounting transition. | NEAR consensus/checkpoint, reviewed verifier implementation, distinct authorizing principals. RPC/indexer supplies data only; it cannot forge a valid proof. | Strongest path that can restore liveness without trusting one external outcome attestation. High implementation, protocol-upgrade, gas, proof-size and audit complexity. If proof/finality cannot be verified, funds remain locked. | **Recommended target only after the feasibility gate.** If not viable, retain A; do not downgrade to B silently. |

### Recommended architecture

Use **A now, C as the only automatic reconciliation target**. Do not introduce a state-changing path until the local proof prototype proves exact receipt lineage and finality and the contract authorization design receives separate approval. A backend may expose a read-only “candidate evidence found” state, but it must continue to report escrow as `Uncertain` and must never label the operation settled or refundable until the contract state changes through an approved, verifiable path.

The planned contract transition, if later approved, should be narrow:

- accept only a proof bundle for an existing `Uncertain` operation;
- verify all immutable terms, causal receipt link, finalized exact outcome, and current operation/security state;
- require the approved independent authorization threshold;
- check Guardian/safe-mode/quarantine and fencing constraints;
- atomically write a terminal reconciliation record and update accounting once;
- on proven failure, return principal only to internal locked/quarantined accounting first; do not automatically create a new transfer or refund;
- on proven success, account as paid/refunded exactly once;
- preserve the lock on every rejected, incomplete, stale, unsupported, or ambiguous case.

## 6. Attack scenarios and required behavior

| Scenario | Required response |
|---|---|
| Malicious RPC reports success for a transfer that failed, or vice versa | Proof validation fails; no accounting change; remain `Uncertain`. |
| Valid outcome proof for a different transfer with the same amount/recipient | Reject because operation ID, source execution, causal link, task, and receipt input do not match. |
| Proof has a valid Merkle path but caller-selected/unfinalized block root | Reject unless the finalized header and validator/finality path are authenticated from the pinned checkpoint. |
| Receipt exists but its input cannot be proven or its source operation is ambiguous | Keep funds locked; do not infer transfer terms from logs alone. |
| `FINAL` times out, node omits a shard, history is pruned, providers disagree, or the network is unavailable | Keep `Uncertain`; retry read-only evidence collection. Never convert query failure into transfer failure. |
| Old task epoch attempts to reconcile, replay, or execute the operation after backup takeover | Reject execution/replay. Any accounting-only closure must be tied to the stored original epoch and cannot expose funds to the stale executor. |
| Replayed proof or duplicate callback races with reconciliation | Permanent on-chain marker and terminal-state guard permit at most one resolution; invariant checks prevent double accounting. |
| Approval omitted, expired, revision-stale, signer roles overlap, or Sentinel unavailable | Reject and keep locked. Guardian hold/quarantine takes precedence. |
| Proof verifier has a parser bug or unsupported protocol version | Fail closed; disable reconciliation rather than treating unknown status as failure. |
| Operator claims a timeout means failed transfer | Reject. Time elapsed is only a signal to investigate. |

## 7. Permanent-lock trade-offs and alternatives

Permanent locking protects against wrongly refunding money after a successful transfer, paying twice, or reopening a stale operation. It can also strand real principal, prevent the task’s normal refund, and require long-lived records and operator attention. That is a deliberate safety/liveness trade-off, not a recoverable state under the current interface.

Safe alternatives, ordered from least to most invasive:

1. **Read-only monitoring:** retain finalized RPC/proof artifacts and alert operators. Display the on-chain operation as uncertain until its callback changes state. No funds move.
2. **Wait for the authentic callback:** if the callback is delayed but eventually executes, the existing path reconciles from the NEAR promise result.
3. **Proof-carrying, separately authorized reconciliation:** implement only after the exact receipt proof and finality feasibility gate, security review, and separate approval.
4. **Governance/legal loss procedure:** if exact proof cannot be established, leave principal locked and handle the unresolved claim outside the contract under an explicitly documented process. This must not be represented as an on-chain refund or recovery.

Do not use an owner timeout override, majority vote based only on screenshots/RPC JSON, account balance deltas, or an upgrade that silently clears pending liability. Account balance deltas are not operation-specific when unrelated deposits, gas, refunds, or concurrent transfers can occur.

## 8. Test plan before implementation

All tests must use ephemeral local NEAR Sandbox accounts and sandbox-only funds. Tests must never target mainnet or use a real wallet. No implementation or test execution is authorized by this design review.

### Stage 0 — Protocol and proof feasibility (read-only prototype)

- Capture actual Sandbox proof material for successful and failed native transfers, their parent REWIND execution, and callback execution.
- Verify the proof against a pinned Sandbox genesis/checkpoint and finalized block using an independent implementation/vector; do not trust a mock proof generator as the verifier oracle.
- Prove the originating execution is this operation and the exact outgoing receipt is a transfer from REWIND to the stored recipient for the stored amount.
- Verify whether the published RPC APIs return all necessary receipt input and outcome material; test missing shard tracking, delayed receipts, and history/pruning behavior.
- Record proof byte size, compute/gas estimates, protocol-version assumptions, trusted checkpoint rotation, and upgrade requirements. Stop the design if exact receipt lineage or finality cannot be established.

### Stage 1 — Pure verifier and state-machine tests

- Valid proof vectors for successful payment, failed payment, successful refund, and failed refund.
- Mutate each field independently: chain/genesis, contract ID/code hash, operation/task ID, kind, recipient, amount, source transaction, receipt ID, outcome block, epoch, security revision, proof hash, proof siblings and finality path. Every mutation must reject.
- Reject valid Merkle inclusion under an unauthenticated root, non-final block, wrong validator set, wrong chain checkpoint, unsupported protocol version, or malformed/oversized proof.
- Reject unknown/pending/terminal operations, stale or future epoch, already-used operation, replayed proof hash, duplicate nonce, duplicate callback, and callback/proof race.
- Property-test accounting conservation and monotonic terminal states: no duplicate payout, refund, availability restoration, pending decrement, or liability decrement.
- Ensure all verifier errors, unknown statuses, incomplete traces and arithmetic overflow fail closed without changing storage.

### Stage 2 — Contract tests in local Sandbox

- Confirm existing callback success/failure behavior and ordinary refunds remain unchanged.
- Create an uncertain operation with the transfer callback deliberately delayed or its callback execution forced to fail; verify principal remains locked and refund/new execution is blocked.
- Submit complete proof plus the approved distinct authorization threshold; assert exactly one terminal state and exact accounting changes.
- Submit proof without each required signer, with duplicate/overlapping role identities, after approval expiry, after Guardian safe mode/quarantine, and after security revision changes. Assert no state change.
- Advance the recovery/task epoch before proof submission. Assert old operation cannot execute or release principal to a stale executor; confirm any permitted accounting-only closure keeps funds quarantined.
- Submit incomplete, forged, mismatched, stale, replayed and wrong-network proofs. Assert `Uncertain`, pending liability and task refund block remain intact.
- Race callback and proof submissions in both orderings. The first valid resolution may win; all later resolutions must be harmless rejects with no duplicate accounting.
- Check storage migration and old in-flight `Pending`/`Uncertain` operations across contract upgrade simulation before any production upgrade proposal.

### Stage 3 — Backend and operational integration

- Backend independently queries configured local RPC and verifies the proof artifact; it must not trust a child process `success` flag, event stream, dashboard payload, or one provider's `FINAL` response.
- Compare backend state to finalized contract views at one pinned block. Only report reconciled success/failure if the contract's terminal record is present and its proof digest/operation terms match.
- Verify restart, duplicate jobs, concurrent reconcilers, provider failover, provider disagreement, unavailable archival data, signer downtime, and durable replay storage behavior.
- Ensure an RPC-only observation remains explicitly “unverified/uncertain” in the API/dashboard data model. No frontend appearance change is part of this design; any needed status semantics require separate review.
- Produce a receipt report linking every displayed recovery/settlement claim to transaction hashes, receipt IDs, finalized block hashes, proof digests, authorization identities, and contract state. No synthetic success counters.

### Release gates

- Independent protocol/security review of proof parser, finality/checkpoint logic, signer separation, contract state migration, and storage/gas limits.
- Reproducible tests pass on at least two independent local verifier implementations for proof vectors.
- No automatic refund/release path from timeout, missing data, RPC claims, or off-chain signature alone.
- Existing contract, Sandbox, backend, and dashboard suites still pass; UI styling, layout, colors and animations remain unchanged.
- Separate explicit approval for each security-sensitive contract/authorization change and a distinct approval before any non-sandbox deployment.

## 9. Staged implementation proposal (approval required)

1. **Approval A — read-only proof prototype:** build an isolated local verifier and fixtures only; no contract or wallet permission changes. Confirm exact receipt lineage and finality feasibility.
2. **Architecture gate:** review prototype evidence, trusted checkpoint model, proof size/gas, operation-to-receipt binding, signer roles, migration plan and failure behavior. If proof verification is incomplete or impractical, retain permanent locking.
3. **Approval B — contract design:** present a concrete state schema, exact transition table, independent authorization policy, replay/fencing rules and upgrade migration. Obtain explicit approval before modifying REWIND settlement or authorization behavior.
4. **Approval C — backend integration:** after contract authorization, add production-shaped proof verification and independent finalized-state verification; keep local sandbox only until separately approved.
5. **Independent audit and deployment review:** verify contracts, proof verifier, key custody, operations, monitoring and rollback/lock behavior. Mainnet deployment remains outside the scope of this design.

## 10. Sources and evidence boundaries

- Project implementation and test evidence: `contracts/rewind-vault/src/lib.rs`, `contracts/rewind-vault/src/tests.rs`, `integration-tests/src/lib.rs`, `integration-tests/src/recovery_sandbox.rs`, `apps/backend/src/network.ts`, `docs/PHASE7-INTEGRATION-REPORT.md`, and `docs/PHASE8-SECURITY-REPORT.md`.
- [NEAR transactions and receipt status RPC](https://docs.near.org/api/rpc/transactions) — finality wait levels and receipt-list limitations.
- [NEAR light-client proof API](https://docs.near.org/api-reference/post-light_client_proof) — documented execution proof request/response.
- [nearcore proof guide](https://github.com/near/nearcore/blob/master/docs/architecture/how/proofs.md) — receipt outcome roots and Merkle verification concepts.
- These external sources establish protocol/API capabilities, not that the proposed project-specific proof verifier exists or is safe. That must be demonstrated by the Stage 0 prototype and independent review.
