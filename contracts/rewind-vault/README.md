# REWIND vault v4.3

Native NEAR escrow implemented in src/lib.rs. No deployment or real-fund use has occurred. Not independently audited; both contracts now build with cargo-near; sandbox execution of the fixed code remains unverified in this session because localhost sockets are blocked. See ../../docs/wasm-link-fix.md.

## Permissions and API

- create_task(task_id, executor, verifier, recipients, escrow_amount, expires_at): any caller funds its own new task. The caller becomes immutable depositor. Each recipient supplies account_id and limit. There may be 1–8 distinct recipients; their total budgets must not exceed funded principal. Executor and verifier must differ. Expiry is a future chain timestamp, at most 30 days away.
- reserve_payment(task_id, operation_id, recipient, amount, commitment): designated executor only. Reserves available task principal and recipient budget; commitment is a 64-character SHA-256 hex string. The recipient must be allowlisted. No transfer occurs yet.
- approve_payment(operation_id, expected_commitment): designated verifier only. Approves the exact immutable operation whose task, amount, recipient and digest it has reviewed. This is an account authorization gate; it does not cryptographically validate checkpoint evidence itself.
- settle_payment(operation_id): designated executor only, with verifier approval and before task expiry. Dispatches a single native transfer and private callback. No method accepts a caller-chosen withdrawal destination at settlement.
- cancel_payment(operation_id): depositor or executor may cancel only Reserved payments, releasing both principal and budget.
- authorize_refund(task_id): designated verifier authorizes early return of unused principal.
- refund(task_id, operation_id): original depositor only, after expiry or verifier authorization. Requires zero Reserved and Pending/Uncertain amounts; returns all available principal to the immutable depositor. Begins permanent task closure to new payments, including if the refund later fails.
- mark_uncertain(operation_id): anyone may flag a Pending transfer after one hour. No principal or budget is released.
- on_transfer(operation_id): private chained callback only, with exactly one promise result. Uses bounded promise_result_checked(0, 0). Only an empty successful native transfer result finalizes payment/refund; a Failed receipt restores principal and payment budget. Unexpected result data keeps the operation Uncertain.
- set_safe_mode(enabled): guardian or owner may enable; only owner may disable. Safe mode blocks funding, reservation, approval and payment settlement. It permits cancellation, receipt reconciliation and authorized refunds.
- get_task(task_id), get_operation(operation_id), accounting(), is_safe_mode(): views. accounting returns [unfinalized_liability, dispatched_in_flight] as decimal strings.

No owner/guardian withdrawal, arbitrary execution, cross-contract verifier override, recipient mutation, top-up, storage deletion or operation retry endpoint exists. Future policy rotation/migrations require their own design and review. Initialize atomically with any eventual sandbox deployment. Fund the contract account's code/state rent and operating reserve separately from user principal.

## Funding and storage

All monetary API values use U128 decimal strings in yoctoNEAR; times use U64 decimal-string nanoseconds. create_task requires exactly escrow_amount + 0.025 NEAR attached. reserve_payment and refund each require exactly 0.01 NEAR attached for operation storage. These bonds are nonrefundable, remain in the vault, and are never counted as escrow principal. Storage growth is measured synchronously using the SDK's legacy LookupMap and checked against each bond. IDs are 1–64 ASCII letters/digits/underscore/dot/hyphen. Bounded IDs and up to eight recipients keep records bounded; maximum-size records are tested.

Example: funding 1 NEAR principal attaches 1.025 NEAR. Each new reservation/refund operation attaches an additional 0.01 NEAR. There is no implicit charge against task principal, and no public storage subsidy. Terminal operation IDs remain permanent replay tombstones. Retention and bond refunds are deliberately not implemented.

## Accounting invariants

For each task:

funded = available + reserved + pending + paid + refunded

Each recipient committed = its reserved payments + pending/uncertain payments + successful payments, always <= its immutable limit. Refunds do not increase recipient commitments.

Global liability = sum(available + reserved + pending). Global in_flight = sum(pending), including Uncertain transfers. Success decrements liability and in_flight exactly once; confirmed failure decrements only in_flight and restores available principal. Before dispatch, balance must back liability minus already-dispatched funds, plus storage and an operation-sized headroom reserve. At least 50 Tgas of remaining call gas is required, with 20 Tgas reserved for the callback.

## State transitions and reconciliation

Payment: Reserved -> Pending -> Succeeded or Failed. Reserved -> Cancelled is terminal. Pending -> Uncertain is observational. A late verified callback reconciles either Pending or Uncertain. Refund goes directly to Pending and has the same receipt reconciliation. Failed/Cancelled/Succeeded IDs cannot be reused, including across tasks and across payment/refund types. After a confirmed failure, retry requires a new ID and, for payments, new verifier approval.

Timeout never proves failure. An Uncertain amount remains in pending accounting and cannot be resent, cancelled or refunded. A refund cannot race any unresolved payment. If a callback permanently fails (for example, runtime out-of-gas), funds may stay locked indefinitely. No proof-based historical receipt recovery or trusted administrator outcome override is implemented. This trades availability for preventing double payment; resolve this recovery design and validate real receipt ordering in sandbox before production use.

## Verification

73 vault unit/receipt tests cover authorization, budget ceilings, principal conservation, task isolation, duplicate IDs/settlements/callbacks, failed payment/refund retry, refund races, uncertain outcomes, safe mode, storage bounds, gas reserve and generated transfer/callback receipts. Existing 16 PHOENIX tests remain passing. See ../../docs/wasm-link-fix.md for current results and ../../integration-tests for the local sandbox suite. The older phase2-validation.md records a prior Windows run. Unit mocks do not replace sandbox execution, fuzzing or an independent financial-contract audit.

Every task update checks principal conservation and recipient commitment totals before persisting state. A failed transfer callback restores accounting availability, but the dispatch backing check still blocks spending until enough native balance is present; failure refunds may arrive asynchronously.

Native dispatch uses SDK env batch actions and promise_return, preserving the final callback boolean while avoiding unrelated universal-account and gas-key imports from the SDK generic Promise dispatcher. The callback remains dependent on the native transfer, carries zero attached deposit and zero unused-gas weight, and reserves exactly 20 Tgas.

## Phase 3 opt-in fencing

`enable_task_fencing(task_id)` is depositor-only before any principal is spent;
it starts epoch 0 and cannot be undone. `advance_task_epoch(task_id, expected_epoch)`
is verifier-only and advances exactly once from the expected epoch. Legacy payment
methods reject fenced tasks. Use `reserve_fenced_payment(..., epoch)`,
`approve_fenced_payment(..., epoch)` and `settle_fenced_payment(operation_id, epoch)`.
All original checks still run. A Reserved payment can be reapproved by its verifier
for the new epoch using the same ID/commitment; a terminal ID can never be reused.
An old Pending/Uncertain transfer still reconciles its authentic callback across an
epoch change and continues to block refunds. No timeout unlocks or resends it.

Phase 3 adds 11 vault tests (73 total). Contract Borsh layouts changed; use fresh
sandbox deployments. See ../../docs/phase3-validation.md for current build hashes,
results and the coordinated backup recovery demonstration.
