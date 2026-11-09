# v5.0 Stage A: Proof-of-Recovery

Stage A adds an auditable receipt for a PHOENIX Core recovery transition. Core
records the task, prior and replacement worker identities, checkpoint digest,
source and destination epochs, security revision, and recovery time as part of
the epoch transition. The record is keyed by `(agent_id, epoch_to)` and cannot
be replaced by a second recovery for that epoch.

Afterwards, SENTINEL may attach one signed receipt binding those exact Core
facts to a unique REWIND settlement reference, successful outcome, supplied
finalized settlement evidence hash and block height. The signature uses a versioned,
domain-separated encoding. Core checks the configured Sentinel key, domain,
nonce sequence, current epoch, security revision and every recovery field.
Forged signatures, unauthorized callers, stale transitions, malformed receipts
and replay are rejected. The public `get_recovery_receipt(agent_id, epoch_to)`
view returns the transition and optional verified attestation without requiring
caller authorization.

## Cross-contract trust boundary

NEAR contracts cannot synchronously read another contract's state. Core does
not claim to independently prove a REWIND operation. The receipt-signing API
checks the supplied operation and evidence fields against the pinned task
effect, but does not itself connect to an RPC endpoint or establish evidence
provenance. The SENTINEL process/operator must independently obtain the payment
and block from a trusted finalized-state observer before calling it. Core then
validates the configured SENTINEL signature and its own immutable recovery
facts. Clients that need to
revalidate a stored receipt can use
`phoenix_recovery::verify_recovery_receipt` with the policy's public key and
`verify_recovery_receipt_evidence` with the evidence retained by the verifier.
These checks establish signature and evidence-hash integrity; they do not prove
that a claimed block is canonical or that the payment existed in it. A verifier
must obtain finalized REWIND state and block identity from a trusted RPC and
compare all operation fields. Independent RPC acquisition and cryptographic
light-client proofs are outside Stage A.

### What is checked where

**Enforced on chain by Core:** caller is the configured SENTINEL account;
signature matches its configured Ed25519 key; receipt domain, task, primary,
backup, checkpoint digest, epoch transition and security revision match the
stored Core recovery; receipt is fresh; nonce is next; and the transition can
be attested only once.

**Observed and supplied by the trusted SENTINEL host:** the REWIND operation
view is `Succeeded`, its task/payment ID/recipient/amount/epoch match the pinned
plan effect, and the view was read at a finalized block identified by height and
hash. SENTINEL checks those values and signs their evidence hash. Core does not
query REWIND and cannot prove the reported outcome itself. The sandbox test
reads the operation at a finalized sandbox block hash, compares the resulting
receipt to that state, and labels that fact as observer-supplied evidence.

An authorized but compromised SENTINEL signer could attest to a false
settlement because Core has no cross-contract proof verifier. The receipt is an
auditable signed assertion with a clear trust boundary, not a trustless proof
that REWIND paid.

Settlement receipts currently attest `Succeeded` only. A failed or uncertain
REWIND outcome does not create a successful receipt and must continue through
REWIND's existing callback/reconciliation/refund controls. Receipt submission
must occur within its short freshness window; once stored, its historical
signature remains verifiable after that window expires.

## Validation

Stage A adds PHOENIX Core tests for valid receipt storage and public reads,
forgery, unauthorized submission, replay and stale epochs. Recovery service
tests verify SENTINEL refuses invalid recovery epochs, failed payments and
mismatched finalized evidence. Existing financial contract rules are unchanged.

Validation run in the development environment:

- `cargo fmt --all -- --check`: passed.
- `cargo test --workspace --locked`: 142 passed (50 Core, 92 REWIND), 0 failed.
- `cargo test --manifest-path services/recovery/Cargo.toml --locked --target-dir "$PWD/services/recovery/target"`: 50 passed (49 library tests and 1 worker-process test), 0 failed.
- `bash scripts/build-near.sh`: both optimized NEAR WASM contracts built and import-audited. Core is 276,904 bytes (SHA-256 `30bc46efddc4120d34acd0213c1cdcd56cd65092e46fbe640c5ffad7eefbb6e5`); REWIND is 237,980 bytes (SHA-256 `fa5c22e03eca8035f3238dcb5970a4b3ee688ccedb0da0f65c0d3a8d994b0227`).
- `cargo test --manifest-path integration-tests/Cargo.toml --locked`: integration crate compiled; all four existing tests and the new Stage A test failed before test setup because near-workspaces could not create a local socket in this execution environment. No sandbox assertions ran here.
- `cargo test --manifest-path integration-tests/Cargo.toml --locked --no-run`: passed after adding `proof_of_recovery_receipt_end_to_end_and_adversarial_cases`.
- `scripts/test-stage-a.sh`: repeatable full Stage A run (formatting, Rust suites, WASM build/import audit and all local sandbox integration tests); sandbox execution requires an Ubuntu environment that permits near-workspaces to bind local sockets.

The sandbox receipt test refreshes the Core heartbeat immediately before its
first checkpoint. This matters because Core measures lease expiry using
`env::block_timestamp()` and expires when elapsed time is greater than or equal
to the configured timeout; setup transactions each advance sandbox chain time.
Core behavior is unchanged. For the simulated crash, the test requests
`Worker::fast_forward(1_000)` and polls finalized block timestamps until the
stored heartbeat's expiry threshold is crossed. This is necessary because the
near-workspaces 0.23 worker wrapper submits `sandbox_fast_forward` without
waiting for finalized blocks to reflect the requested advance. Timeout errors
include last heartbeat, current block timestamp, expiry threshold, elapsed time
and finalized block height. The Core suite also tests that a checkpoint commit
at the exact one-second lease boundary is rejected as expired. Current Core
count is 50 after the expiry and recovery-activation regressions; REWIND remains at 92.

The new integration test covers actual Core and REWIND deployments, a signed
primary checkpoint, simulated primary failure, backup epoch recovery, authorized
fenced escrow settlement, receipt signing/submission, public receipt lookup,
and rejection of forged signatures, stale epochs, duplicate receipts and
modified checkpoint hashes. It also asks SENTINEL to reject mismatched supplied
settlement evidence. The payment assertion polls finalized REWIND views while
advancing real sandbox blocks, accepts only `Succeeded`, checks the recipient's
balance delta against the exact payment amount, then retries the same operation
ID and requires rejection with no further balance change. These cases are
source-implemented, but did not execute in this restricted environment because
the sandbox runtime could not create its local socket.

REWIND's `Operation.approved` is a live pending-approval flag and is reset to
false by its private callback after either terminal transfer outcome. Therefore
the successful receipt path requires finalized `Succeeded`, the exact pinned
amount and recipient, and the verified balance delta; it does not expect the
consumed live approval flag to remain true. SENTINEL rejects nonterminal
unapproved operations and amounts that differ from the pinned plan effect.

This stage is sandbox-only. It does not include the recovery mesh, testnet
deployment, dashboard changes, or the Stage F property/sandbox test expansion.
