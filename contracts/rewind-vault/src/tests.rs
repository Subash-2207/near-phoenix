use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const N: u128 = 1_000_000_000_000_000_000_000_000;
const FUND: u128 = 10 * N;
const EXPIRY: u64 = 1_000_000_000_000;
fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn digest() -> String {
    "ab".repeat(32)
}
fn context(caller: &str, deposit: u128, time: u64) {
    context_results(caller, deposit, time, vec![]);
}
fn context_results(caller: &str, deposit: u128, time: u64, results: Vec<PromiseResult>) {
    let c = VMContextBuilder::new()
        .current_account_id(id("vault.testnet"))
        .predecessor_account_id(id(caller))
        .signer_account_id(id(caller))
        .block_timestamp(time)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(1000))
        .prepaid_gas(Gas::from_tgas(300))
        .build();
    testing_env!(
        c,
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}
fn create(v: &mut RewindVault, task: &str) {
    context("depositor.testnet", FUND + TASK_STORAGE_BOND, 1);
    v.create_task(
        task.into(),
        id("executor.testnet"),
        id("verifier.testnet"),
        vec![
            RecipientBudget {
                account_id: id("alice.testnet"),
                limit: U128(6 * N),
            },
            RecipientBudget {
                account_id: id("bob.testnet"),
                limit: U128(4 * N),
            },
        ],
        U128(FUND),
        U64(EXPIRY),
    );
}
fn setup() -> RewindVault {
    context("admin.testnet", 0, 1);
    let mut v = RewindVault::new(id("admin.testnet"), id("guardian.testnet"));
    create(&mut v, "task");
    v
}
fn reserve(v: &mut RewindVault, op: &str, amount: u128) {
    context("executor.testnet", OP_STORAGE_BOND, 2);
    v.reserve_payment(
        "task".into(),
        op.into(),
        id("alice.testnet"),
        U128(amount),
        digest(),
    );
}
fn approve(v: &mut RewindVault, op: &str) {
    context("verifier.testnet", 0, 3);
    v.approve_payment(op.into(), digest());
}
fn send(v: &mut RewindVault, op: &str) {
    context("executor.testnet", 0, 4);
    v.settle_payment(op.into());
}
fn pending(v: &mut RewindVault) {
    reserve(v, "pay", 3 * N);
    approve(v, "pay");
    send(v, "pay");
}
fn callback(v: &mut RewindVault, op: &str, success: bool) -> bool {
    context_results(
        "vault.testnet",
        0,
        5,
        vec![if success {
            PromiseResult::Successful(vec![])
        } else {
            PromiseResult::Failed
        }],
    );
    v.on_transfer(op.into())
}
fn task(v: &RewindVault) -> Task {
    v.get_task("task".into()).unwrap()
}
fn invariant(v: &RewindVault) {
    let t = task(v);
    assert_eq!(
        t.funded.0,
        t.available.0 + t.reserved.0 + t.pending.0 + t.paid.0 + t.refunded.0
    );
    assert_eq!(
        v.accounting().0 .0,
        t.available.0 + t.reserved.0 + t.pending.0
    );
    assert_eq!(v.accounting().1, t.pending);
    let committed: u128 = t
        .recipients
        .iter()
        .map(|r| {
            assert!(r.committed.0 <= r.limit.0);
            r.committed.0
        })
        .sum();
    // These helpers check payment-only states, before refund dispatch.
    if !t.refund_started {
        assert_eq!(committed, t.reserved.0 + t.pending.0 + t.paid.0);
    }
}
#[test]
fn user_deposit_excludes_storage_bond() {
    let v = setup();
    let t = task(&v);
    assert_eq!(t.depositor, id("depositor.testnet"));
    assert_eq!(t.funded, U128(FUND));
    assert_eq!(t.available, U128(FUND));
    invariant(&v);
}
#[test]
fn success_receipt_settles_once_and_preserves_principal() {
    let mut v = setup();
    reserve(&mut v, "pay", 3 * N);
    invariant(&v);
    approve(&mut v, "pay");
    send(&mut v, "pay");
    invariant(&v);
    assert!(callback(&mut v, "pay", true));
    invariant(&v);
    assert_eq!(task(&v).paid, U128(3 * N));
    assert_eq!(task(&v).available, U128(7 * N));
    assert_eq!(v.operation(&"pay".into()).state, OperationState::Succeeded);
}
#[test]
fn native_transfer_receipt_has_exact_recipient_amount_and_private_callback() {
    let mut v = setup();
    pending(&mut v);
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0].receiver_id, id("alice.testnet"));
    assert!(receipts[0]
        .actions
        .iter()
        .any(|a| matches!(a,MockAction::Transfer{deposit,..} if deposit.as_yoctonear()==3*N)));
    assert_eq!(receipts[1].receiver_id, id("vault.testnet"));
    assert_eq!(receipts[1].receipt_indices.len(), 1);
    assert!(receipts[1].actions.iter().any(|a|matches!(a,MockAction::FunctionCallWeight{method_name,args,attached_deposit,prepaid_gas,gas_weight,..} if method_name==b"on_transfer" && near_sdk::serde_json::from_slice::<near_sdk::serde_json::Value>(args).unwrap()["operation_id"]=="pay" && attached_deposit.is_zero() && *prepaid_gas==Gas::from_tgas(20) && gas_weight.0==0)));
}
#[test]
#[should_panic(expected = "Executor only")]
fn unauthorized_withdrawal_reservation() {
    let mut v = setup();
    context("attacker.testnet", OP_STORAGE_BOND, 2);
    v.reserve_payment(
        "task".into(),
        "pay".into(),
        id("alice.testnet"),
        U128(N),
        digest(),
    );
}
#[test]
#[should_panic(expected = "Executor only")]
fn admin_cannot_withdraw_user_escrow() {
    let mut v = setup();
    reserve(&mut v, "pay", N);
    approve(&mut v, "pay");
    context("admin.testnet", 0, 4);
    v.settle_payment("pay".into());
}
#[test]
#[should_panic(expected = "Unauthorized recipient")]
fn recipient_allowlist_enforced() {
    let mut v = setup();
    context("executor.testnet", OP_STORAGE_BOND, 2);
    v.reserve_payment(
        "task".into(),
        "pay".into(),
        id("attacker.testnet"),
        U128(N),
        digest(),
    );
}
#[test]
#[should_panic(expected = "Recipient budget exceeded")]
fn recipient_budget_enforced() {
    let mut v = setup();
    reserve(&mut v, "pay", 7 * N);
}
#[test]
#[should_panic(expected = "Insufficient task balance")]
fn insufficient_task_balance() {
    let mut v = setup();
    reserve(&mut v, "pay", 11 * N);
}
#[test]
#[should_panic(expected = "Recipient budget exceeded")]
fn paid_amount_still_consumes_recipient_budget() {
    let mut v = setup();
    reserve(&mut v, "pay", 6 * N);
    approve(&mut v, "pay");
    send(&mut v, "pay");
    callback(&mut v, "pay", true);
    reserve(&mut v, "second", N);
}
#[test]
#[should_panic(expected = "Operation not reserved")]
fn duplicate_settlement_while_pending() {
    let mut v = setup();
    pending(&mut v);
    send(&mut v, "pay");
}
#[test]
#[should_panic(expected = "Operation not reserved")]
fn duplicate_settlement_after_success() {
    let mut v = setup();
    pending(&mut v);
    callback(&mut v, "pay", true);
    send(&mut v, "pay");
}
#[test]
#[should_panic(expected = "Operation ID already used")]
fn operation_ids_global_across_tasks() {
    let mut v = setup();
    reserve(&mut v, "pay", N);
    create(&mut v, "other");
    context("executor.testnet", OP_STORAGE_BOND, 2);
    v.reserve_payment(
        "other".into(),
        "pay".into(),
        id("alice.testnet"),
        U128(N),
        digest(),
    );
}
#[test]
#[should_panic(expected = "Verifier only")]
fn executor_cannot_self_approve() {
    let mut v = setup();
    reserve(&mut v, "pay", N);
    context("executor.testnet", 0, 3);
    v.approve_payment("pay".into(), digest());
}
#[test]
#[should_panic(expected = "Verified approval required")]
fn settlement_requires_independent_approval() {
    let mut v = setup();
    reserve(&mut v, "pay", N);
    send(&mut v, "pay");
}
#[test]
#[should_panic(expected = "Commitment mismatch")]
fn verifier_must_review_exact_commitment() {
    let mut v = setup();
    reserve(&mut v, "pay", N);
    context("verifier.testnet", 0, 3);
    v.approve_payment("pay".into(), "cd".repeat(32));
}
#[test]
fn failed_transfer_restores_funds_and_budget_with_new_operation_retry() {
    let mut v = setup();
    pending(&mut v);
    assert!(!callback(&mut v, "pay", false));
    invariant(&v);
    assert_eq!(task(&v).available, U128(FUND));
    assert_eq!(task(&v).recipients[0].committed, U128(0));
    assert_eq!(v.operation(&"pay".into()).state, OperationState::Failed);
    reserve(&mut v, "retry", 3 * N);
    approve(&mut v, "retry");
    send(&mut v, "retry");
    assert!(callback(&mut v, "retry", true));
    invariant(&v);
}
#[test]
#[should_panic(expected = "Operation ID already used")]
fn failed_operation_id_cannot_be_reused() {
    let mut v = setup();
    pending(&mut v);
    callback(&mut v, "pay", false);
    reserve(&mut v, "pay", N);
}
#[test]
fn depositor_cancels_reserved_payment_then_refunds() {
    let mut v = setup();
    reserve(&mut v, "pay", N);
    context("depositor.testnet", 0, 3);
    v.cancel_payment("pay".into());
    invariant(&v);
    assert_eq!(v.operation(&"pay".into()).state, OperationState::Cancelled);
    context("depositor.testnet", OP_STORAGE_BOND, EXPIRY);
    v.refund("task".into(), "refund".into());
    assert!(callback(&mut v, "refund", true));
    invariant(&v);
    assert_eq!(task(&v).refunded, U128(FUND));
    assert_eq!(v.accounting(), (U128(0), U128(0)));
}
#[test]
#[should_panic(expected = "Operation not reserved")]
fn pending_payment_cannot_be_cancelled() {
    let mut v = setup();
    pending(&mut v);
    context("depositor.testnet", 0, 5);
    v.cancel_payment("pay".into());
}
#[test]
#[should_panic(expected = "Unresolved operations")]
fn refund_race_with_reserved_payment() {
    let mut v = setup();
    reserve(&mut v, "pay", N);
    context("depositor.testnet", OP_STORAGE_BOND, EXPIRY);
    v.refund("task".into(), "refund".into());
}
#[test]
#[should_panic(expected = "Unresolved operations")]
fn refund_race_with_pending_transfer() {
    let mut v = setup();
    pending(&mut v);
    context("depositor.testnet", OP_STORAGE_BOND, EXPIRY);
    v.refund("task".into(), "refund".into());
}
#[test]
#[should_panic(expected = "Depositor only")]
fn unauthorized_refund() {
    let mut v = setup();
    context("attacker.testnet", OP_STORAGE_BOND, EXPIRY);
    v.refund("task".into(), "refund".into());
}
#[test]
#[should_panic(expected = "Refund not authorized")]
fn early_refund_without_verifier_denied() {
    let mut v = setup();
    context("depositor.testnet", OP_STORAGE_BOND, 5);
    v.refund("task".into(), "refund".into());
}
#[test]
fn verifier_early_refund_goes_only_to_depositor() {
    let mut v = setup();
    context("verifier.testnet", 0, 2);
    v.authorize_refund("task".into());
    context("depositor.testnet", OP_STORAGE_BOND, 3);
    v.refund("task".into(), "refund".into());
    assert_eq!(
        v.operation(&"refund".into()).recipient,
        id("depositor.testnet")
    );
    assert!(callback(&mut v, "refund", true));
    invariant(&v);
}
#[test]
#[should_panic(expected = "Unresolved operations")]
fn double_refund_while_pending() {
    let mut v = setup();
    context("depositor.testnet", OP_STORAGE_BOND, EXPIRY);
    v.refund("task".into(), "r1".into());
    context("depositor.testnet", OP_STORAGE_BOND, EXPIRY);
    v.refund("task".into(), "r2".into());
}
#[test]
#[should_panic(expected = "Nothing to refund")]
fn double_refund_after_success() {
    let mut v = setup();
    context("depositor.testnet", OP_STORAGE_BOND, EXPIRY);
    v.refund("task".into(), "r1".into());
    callback(&mut v, "r1", true);
    context("depositor.testnet", OP_STORAGE_BOND, EXPIRY);
    v.refund("task".into(), "r2".into());
}
#[test]
fn failed_refund_can_retry_with_new_id_only() {
    let mut v = setup();
    context("depositor.testnet", OP_STORAGE_BOND, EXPIRY);
    v.refund("task".into(), "r1".into());
    assert!(!callback(&mut v, "r1", false));
    invariant(&v);
    context("depositor.testnet", OP_STORAGE_BOND, EXPIRY);
    v.refund("task".into(), "r2".into());
    assert!(callback(&mut v, "r2", true));
    invariant(&v);
}
#[test]
#[should_panic(expected = "Private callback")]
fn external_callback_spoofing_denied() {
    let mut v = setup();
    pending(&mut v);
    context_results(
        "attacker.testnet",
        0,
        5,
        vec![PromiseResult::Successful(vec![])],
    );
    v.on_transfer("pay".into());
}
#[test]
#[should_panic(expected = "Exactly one transfer result required")]
fn callback_requires_receipt_result() {
    let mut v = setup();
    pending(&mut v);
    context("vault.testnet", 0, 5);
    v.on_transfer("pay".into());
}
#[test]
#[should_panic(expected = "Exactly one transfer result required")]
fn callback_rejects_extra_receipt_results() {
    let mut v = setup();
    pending(&mut v);
    context_results(
        "vault.testnet",
        0,
        5,
        vec![PromiseResult::Successful(vec![]), PromiseResult::Failed],
    );
    v.on_transfer("pay".into());
}
#[test]
#[should_panic(expected = "Operation not pending")]
fn duplicate_callback_denied() {
    let mut v = setup();
    pending(&mut v);
    callback(&mut v, "pay", true);
    callback(&mut v, "pay", true);
}
#[test]
fn uncertain_transfer_stays_locked_and_late_success_reconciles() {
    let mut v = setup();
    pending(&mut v);
    context("observer.testnet", 0, UNCERTAIN_AFTER_NS + 4);
    v.mark_uncertain("pay".into());
    invariant(&v);
    assert_eq!(task(&v).pending, U128(3 * N));
    assert_eq!(v.operation(&"pay".into()).state, OperationState::Uncertain);
    assert!(callback(&mut v, "pay", true));
    invariant(&v);
    assert_eq!(task(&v).paid, U128(3 * N));
}
#[test]
fn uncertain_failure_reconciles_without_double_counting() {
    let mut v = setup();
    pending(&mut v);
    context("observer.testnet", 0, UNCERTAIN_AFTER_NS + 4);
    v.mark_uncertain("pay".into());
    assert!(!callback(&mut v, "pay", false));
    invariant(&v);
    assert_eq!(task(&v).available, U128(FUND));
}
#[test]
#[should_panic(expected = "Operation not reserved")]
fn uncertain_payment_cannot_be_retried() {
    let mut v = setup();
    pending(&mut v);
    context("observer.testnet", 0, UNCERTAIN_AFTER_NS + 4);
    v.mark_uncertain("pay".into());
    send(&mut v, "pay");
}
#[test]
#[should_panic(expected = "Unresolved operations")]
fn uncertain_payment_cannot_be_refunded() {
    let mut v = setup();
    pending(&mut v);
    context("observer.testnet", 0, UNCERTAIN_AFTER_NS + 4);
    v.mark_uncertain("pay".into());
    context("depositor.testnet", OP_STORAGE_BOND, UNCERTAIN_AFTER_NS + 5);
    v.refund("task".into(), "refund".into());
}
#[test]
fn unexpected_callback_data_fails_closed() {
    let mut v = setup();
    pending(&mut v);
    context_results(
        "vault.testnet",
        0,
        5,
        vec![PromiseResult::Successful(vec![1])],
    );
    assert!(!v.on_transfer("pay".into()));
    assert_eq!(v.operation(&"pay".into()).state, OperationState::Uncertain);
    invariant(&v);
}
#[test]
#[should_panic(expected = "Outcome not overdue")]
fn uncertainty_requires_timeout() {
    let mut v = setup();
    pending(&mut v);
    context("observer.testnet", 0, 5);
    v.mark_uncertain("pay".into());
}
#[test]
#[should_panic(expected = "Vault in safe mode")]
fn safe_mode_blocks_new_settlement() {
    let mut v = setup();
    reserve(&mut v, "pay", N);
    approve(&mut v, "pay");
    context("guardian.testnet", 0, 4);
    v.set_safe_mode(true);
    send(&mut v, "pay");
}
#[test]
fn safe_mode_keeps_callbacks_and_authorized_refunds_working() {
    let mut v = setup();
    pending(&mut v);
    context("guardian.testnet", 0, 4);
    v.set_safe_mode(true);
    assert!(callback(&mut v, "pay", true));
    context("depositor.testnet", OP_STORAGE_BOND, EXPIRY);
    v.refund("task".into(), "refund".into());
    assert!(callback(&mut v, "refund", true));
    invariant(&v);
    assert_eq!(task(&v).paid, U128(3 * N));
    assert_eq!(task(&v).refunded, U128(7 * N));
}
#[test]
#[should_panic(expected = "Owner only")]
fn guardian_cannot_exit_safe_mode() {
    let mut v = setup();
    context("guardian.testnet", 0, 4);
    v.set_safe_mode(true);
    v.set_safe_mode(false);
}
#[test]
#[should_panic(expected = "Insufficient vault backing")]
fn underfunded_vault_cannot_spend_other_principal() {
    let mut v = setup();
    reserve(&mut v, "pay", N);
    approve(&mut v, "pay");
    let c = VMContextBuilder::new()
        .current_account_id(id("vault.testnet"))
        .predecessor_account_id(id("executor.testnet"))
        .block_timestamp(4)
        .account_balance(NearToken::from_near(1))
        .prepaid_gas(Gas::from_tgas(300))
        .build();
    testing_env!(c);
    v.settle_payment("pay".into());
}
#[test]
fn tasks_are_isolated() {
    let mut v = setup();
    create(&mut v, "other");
    pending(&mut v);
    callback(&mut v, "pay", true);
    let other = v.get_task("other".into()).unwrap();
    assert_eq!(other.available, U128(FUND));
    assert_eq!(other.paid, U128(0));
    assert_eq!(v.accounting(), (U128(17 * N), U128(0)));
}
#[test]
#[should_panic(expected = "Task expired")]
fn expired_reserved_payment_cannot_settle() {
    let mut v = setup();
    reserve(&mut v, "pay", N);
    approve(&mut v, "pay");
    context("executor.testnet", 0, EXPIRY);
    v.settle_payment("pay".into());
}
#[test]
#[should_panic(expected = "Operation storage bond required")]
fn operations_cannot_consume_escrow_for_storage() {
    let mut v = setup();
    context("executor.testnet", 0, 2);
    v.reserve_payment(
        "task".into(),
        "pay".into(),
        id("alice.testnet"),
        U128(N),
        digest(),
    );
}
#[test]
#[should_panic(expected = "Verifier only")]
fn unauthorized_early_refund_approval() {
    let mut v = setup();
    context("depositor.testnet", 0, 2);
    v.authorize_refund("task".into());
}
#[test]
#[should_panic(expected = "Guardian or owner only")]
fn attacker_cannot_toggle_safe_mode() {
    let mut v = setup();
    context("attacker.testnet", 0, 2);
    v.set_safe_mode(true);
}
#[test]
#[should_panic(expected = "Vault in safe mode")]
fn safe_mode_blocks_new_reservations() {
    let mut v = setup();
    context("guardian.testnet", 0, 2);
    v.set_safe_mode(true);
    reserve(&mut v, "pay", N);
}
#[test]
fn safe_mode_allows_cancellation_and_owner_can_resume() {
    let mut v = setup();
    reserve(&mut v, "pay", N);
    context("guardian.testnet", 0, 3);
    v.set_safe_mode(true);
    context("depositor.testnet", 0, 4);
    v.cancel_payment("pay".into());
    invariant(&v);
    context("admin.testnet", 0, 5);
    v.set_safe_mode(false);
    assert!(!v.is_safe_mode());
    reserve(&mut v, "new", N);
}
#[test]
#[should_panic(expected = "Vault in safe mode")]
fn safe_mode_blocks_new_funding() {
    let mut v = setup();
    context("guardian.testnet", 0, 2);
    v.set_safe_mode(true);
    create(&mut v, "other");
}
#[test]
#[should_panic(expected = "Task refunding")]
fn failed_early_refund_cannot_reopen_payments() {
    let mut v = setup();
    context("verifier.testnet", 0, 2);
    v.authorize_refund("task".into());
    context("depositor.testnet", OP_STORAGE_BOND, 3);
    v.refund("task".into(), "r1".into());
    callback(&mut v, "r1", false);
    reserve(&mut v, "pay", N);
}
#[test]
fn uncertain_refund_late_failure_can_retry_safely() {
    let mut v = setup();
    context("depositor.testnet", OP_STORAGE_BOND, EXPIRY);
    v.refund("task".into(), "r1".into());
    context("observer.testnet", 0, EXPIRY + UNCERTAIN_AFTER_NS);
    v.mark_uncertain("r1".into());
    assert!(!callback(&mut v, "r1", false));
    invariant(&v);
    context(
        "depositor.testnet",
        OP_STORAGE_BOND,
        EXPIRY + UNCERTAIN_AFTER_NS + 1,
    );
    v.refund("task".into(), "r2".into());
    assert!(callback(&mut v, "r2", true));
    invariant(&v);
}
#[test]
#[should_panic(expected = "Unresolved operations")]
fn uncertain_refund_does_not_authorize_second_refund() {
    let mut v = setup();
    context("depositor.testnet", OP_STORAGE_BOND, EXPIRY);
    v.refund("task".into(), "r1".into());
    context("observer.testnet", 0, EXPIRY + UNCERTAIN_AFTER_NS);
    v.mark_uncertain("r1".into());
    context(
        "depositor.testnet",
        OP_STORAGE_BOND,
        EXPIRY + UNCERTAIN_AFTER_NS + 1,
    );
    v.refund("task".into(), "r2".into());
}
#[test]
#[should_panic(expected = "Operation not pending")]
fn callback_cannot_finalize_a_reserved_operation() {
    let mut v = setup();
    reserve(&mut v, "pay", N);
    callback(&mut v, "pay", true);
}
#[test]
#[should_panic(expected = "Independent verifier required")]
fn task_cannot_designate_executor_as_verifier() {
    let mut v = setup();
    context("depositor.testnet", FUND + TASK_STORAGE_BOND, 1);
    v.create_task(
        "other".into(),
        id("executor.testnet"),
        id("executor.testnet"),
        vec![RecipientBudget {
            account_id: id("alice.testnet"),
            limit: U128(N),
        }],
        U128(FUND),
        U64(EXPIRY),
    );
}
#[test]
#[should_panic(expected = "Escrow plus task storage bond required")]
fn funding_requires_actual_attached_principal() {
    let mut v = setup();
    context("depositor.testnet", TASK_STORAGE_BOND, 1);
    v.create_task(
        "other".into(),
        id("executor.testnet"),
        id("verifier.testnet"),
        vec![RecipientBudget {
            account_id: id("alice.testnet"),
            limit: U128(N),
        }],
        U128(FUND),
        U64(EXPIRY),
    );
}
#[test]
#[should_panic(expected = "Budgets exceed escrow")]
fn aggregate_budgets_cannot_exceed_principal() {
    let mut v = setup();
    context("depositor.testnet", FUND + TASK_STORAGE_BOND, 1);
    v.create_task(
        "other".into(),
        id("executor.testnet"),
        id("verifier.testnet"),
        vec![RecipientBudget {
            account_id: id("alice.testnet"),
            limit: U128(11 * N),
        }],
        U128(FUND),
        U64(EXPIRY),
    );
}
#[test]
fn maximum_sized_task_and_operation_are_storage_funded() {
    let mut v = setup();
    context("depositor.testnet", FUND + TASK_STORAGE_BOND, 1);
    let recipients = (0..8)
        .map(|i| RecipientBudget {
            account_id: id(&format!("{}{}", "x".repeat(63), i)),
            limit: U128(N),
        })
        .collect();
    v.create_task(
        "t".repeat(64),
        id(&"e".repeat(64)),
        id(&"v".repeat(64)),
        recipients,
        U128(FUND),
        U64(EXPIRY),
    );
    context(&"e".repeat(64), OP_STORAGE_BOND, 2);
    v.reserve_payment(
        "t".repeat(64),
        "o".repeat(64),
        id(&format!("{}0", "x".repeat(63))),
        U128(N),
        digest(),
    );
    assert_eq!(v.operation(&"o".repeat(64)).state, OperationState::Reserved);
}
#[test]
#[should_panic(expected = "Insufficient callback gas")]
fn transfer_does_not_dispatch_without_callback_gas() {
    let mut v = setup();
    reserve(&mut v, "pay", N);
    approve(&mut v, "pay");
    let c = VMContextBuilder::new()
        .current_account_id(id("vault.testnet"))
        .predecessor_account_id(id("executor.testnet"))
        .block_timestamp(4)
        .account_balance(NearToken::from_near(1000))
        .prepaid_gas(Gas::from_tgas(40))
        .build();
    testing_env!(c);
    v.settle_payment("pay".into());
}
#[test]
fn multiple_outstanding_operations_keep_separate_outcomes() {
    let mut v = setup();
    reserve(&mut v, "pay", 2 * N);
    reserve(&mut v, "other", 3 * N);
    approve(&mut v, "pay");
    approve(&mut v, "other");
    send(&mut v, "pay");
    send(&mut v, "other");
    invariant(&v);
    assert!(!callback(&mut v, "other", false));
    invariant(&v);
    assert!(callback(&mut v, "pay", true));
    invariant(&v);
    assert_eq!(task(&v).available, U128(8 * N));
    assert_eq!(task(&v).paid, U128(2 * N));
}

#[test]
#[should_panic(expected = "Task principal invariant")]
fn task_update_rejects_broken_principal_accounting() {
    let mut v = setup();
    let mut t = task(&v);
    t.available = U128(FUND - 1);
    v.save_task(&"task".into(), &t);
}

#[test]
#[should_panic(expected = "Task commitment invariant")]
fn task_update_rejects_unbacked_budget_commitment() {
    let mut v = setup();
    let mut t = task(&v);
    t.recipients[0].committed = U128(N);
    v.save_task(&"task".into(), &t);
}

#[test]
#[should_panic(expected = "Insufficient vault backing")]
fn failed_transfer_cannot_respend_before_native_refund_arrives() {
    let mut v = setup();
    pending(&mut v);
    callback(&mut v, "pay", false);
    reserve(&mut v, "retry", N);
    approve(&mut v, "retry");
    // Callback failure proves the outcome, not that the refund receipt has arrived.
    // Model the vault with the failed transfer's principal still absent.
    let c = VMContextBuilder::new()
        .current_account_id(id("vault.testnet"))
        .predecessor_account_id(id("executor.testnet"))
        .block_timestamp(6)
        .account_balance(NearToken::from_yoctonear(7 * N))
        .prepaid_gas(Gas::from_tgas(300))
        .build();
    testing_env!(c);
    v.settle_payment("retry".into());
}

fn fenced_setup() -> RewindVault {
    let mut v = setup();
    context("depositor.testnet", 0, 1);
    v.enable_task_fencing("task".into());
    v
}
fn fenced_reserve(v: &mut RewindVault, op: &str, epoch: u64) {
    context("executor.testnet", OP_STORAGE_BOND, 2);
    v.reserve_fenced_payment(
        "task".into(),
        op.into(),
        id("alice.testnet"),
        U128(N),
        digest(),
        U64(epoch),
    );
}
fn fenced_approve(v: &mut RewindVault, op: &str, epoch: u64) {
    context("verifier.testnet", 0, 3);
    v.approve_fenced_payment(op.into(), digest(), U64(epoch));
}
fn advance(v: &mut RewindVault) {
    context("verifier.testnet", 0, 4);
    v.advance_task_epoch("task".into(), U64(0));
}
#[test]
fn fenced_success_still_obeys_all_principal_invariants() {
    let mut v = fenced_setup();
    fenced_reserve(&mut v, "pay", 0);
    fenced_approve(&mut v, "pay", 0);
    context("executor.testnet", 0, 4);
    v.settle_fenced_payment("pay".into(), U64(0));
    assert!(callback(&mut v, "pay", true));
    invariant(&v);
}
#[test]
#[should_panic(expected = "Stale task epoch")]
fn legacy_reservation_cannot_bypass_task_fence() {
    let mut v = fenced_setup();
    reserve(&mut v, "pay", N);
}
#[test]
#[should_panic(expected = "Stale task epoch")]
fn legacy_approval_cannot_bypass_task_fence() {
    let mut v = fenced_setup();
    fenced_reserve(&mut v, "pay", 0);
    approve(&mut v, "pay");
}
#[test]
#[should_panic(expected = "Stale task epoch")]
fn legacy_settlement_cannot_bypass_task_fence() {
    let mut v = fenced_setup();
    fenced_reserve(&mut v, "pay", 0);
    fenced_approve(&mut v, "pay", 0);
    send(&mut v, "pay");
}
#[test]
#[should_panic(expected = "Stale task epoch")]
fn stale_coordinator_cannot_dispatch_after_epoch_advance() {
    let mut v = fenced_setup();
    fenced_reserve(&mut v, "pay", 0);
    fenced_approve(&mut v, "pay", 0);
    advance(&mut v);
    context("executor.testnet", 0, 5);
    v.settle_fenced_payment("pay".into(), U64(0));
}
#[test]
#[should_panic(expected = "Payment approval epoch mismatch")]
fn old_approval_cannot_dispatch_in_new_epoch() {
    let mut v = fenced_setup();
    fenced_reserve(&mut v, "pay", 0);
    fenced_approve(&mut v, "pay", 0);
    advance(&mut v);
    context("executor.testnet", 0, 5);
    v.settle_fenced_payment("pay".into(), U64(1));
}
#[test]
fn verifier_can_renew_reserved_payment_without_changing_payment_id() {
    let mut v = fenced_setup();
    fenced_reserve(&mut v, "pay", 0);
    fenced_approve(&mut v, "pay", 0);
    advance(&mut v);
    fenced_approve(&mut v, "pay", 1);
    context("executor.testnet", 0, 5);
    v.settle_fenced_payment("pay".into(), U64(1));
    assert!(callback(&mut v, "pay", true));
    invariant(&v);
}
#[test]
#[should_panic(expected = "Verifier only")]
fn coordinator_cannot_advance_its_own_spending_epoch() {
    let mut v = fenced_setup();
    context("executor.testnet", 0, 4);
    v.advance_task_epoch("task".into(), U64(0));
}
#[test]
fn old_inflight_callback_reconciles_after_epoch_advance() {
    let mut v = fenced_setup();
    fenced_reserve(&mut v, "pay", 0);
    fenced_approve(&mut v, "pay", 0);
    context("executor.testnet", 0, 4);
    v.settle_fenced_payment("pay".into(), U64(0));
    advance(&mut v);
    assert!(callback(&mut v, "pay", true));
    invariant(&v);
}
#[test]
#[should_panic(expected = "Operation ID already used")]
fn same_payment_id_cannot_be_reserved_in_new_epoch() {
    let mut v = fenced_setup();
    fenced_reserve(&mut v, "pay", 0);
    fenced_approve(&mut v, "pay", 0);
    context("executor.testnet", 0, 4);
    v.settle_fenced_payment("pay".into(), U64(0));
    callback(&mut v, "pay", true);
    advance(&mut v);
    fenced_reserve(&mut v, "pay", 1);
}
#[test]
fn fenced_task_refunds_keep_original_depositor_destination() {
    let mut v = fenced_setup();
    advance(&mut v);
    context("depositor.testnet", OP_STORAGE_BOND, EXPIRY);
    v.refund("task".into(), "refund".into());
    assert!(callback(&mut v, "refund", true));
    invariant(&v);
    assert_eq!(task(&v).refunded, U128(FUND));
}

fn p4_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn p4_policy() -> ApprovalPolicy {
    use ed25519_dalek::SigningKey;
    let worker = p4_hex(SigningKey::from_bytes(&[1; 32]).verifying_key().as_bytes());
    ApprovalPolicy {
        domain: phoenix_security_types::Domain {
            network: "sandbox".into(),
            deployment: "vault-unit-run".into(),
            core_id: "core.testnet".into(),
            vault_id: "vault.testnet".into(),
            agent_id: "agent.testnet".into(),
            task_id: "task".into(),
            execution_id: "execution".into(),
            code_digest: "aa".repeat(32),
            policy_digest: "bb".repeat(32),
        },
        public_key: p4_hex(SigningKey::from_bytes(&[9; 32]).verifying_key().as_bytes()),
        requester: "executor.testnet".into(),
        verifier: "verifier.testnet".into(),
        worker_keys: vec![worker],
        last_nonce: 0,
        allowed_actions: vec![Action::Payment],
        allowed_recipients: vec!["alice.testnet".into(), "bob.testnet".into()],
        max_payment: (6 * N).to_string(),
    }
}
fn p4_setup() -> RewindVault {
    let mut v = fenced_setup();
    context("depositor.testnet", SENTINEL_STORAGE_BOND, 1);
    v.configure_sentinel("task".into(), p4_policy());
    fenced_reserve(&mut v, "pay", 0);
    v
}
fn p4_ticket(nonce: u64, revision: u64) -> SignedApproval {
    let policy = p4_policy();
    p4_sign(
        phoenix_security_types::ApprovalBody {
            domain: policy.domain,
            action: Action::Payment,
            requester: policy.requester,
            subject_key: policy.worker_keys[0].clone(),
            epoch: 0,
            security_revision: revision,
            checkpoint_digest: "cd".repeat(32),
            operation_id: "pay".into(),
            recipient: "alice.testnet".into(),
            amount: N.to_string(),
            commitment: digest(),
            nonce,
            issued_at: 3,
            expires_at: 100,
        },
        9,
    )
}
fn p4_sign(body: phoenix_security_types::ApprovalBody, seed: u8) -> SignedApproval {
    use ed25519_dalek::{Signer, SigningKey};
    let signature = p4_hex(
        &SigningKey::from_bytes(&[seed; 32])
            .sign(&body.signing_bytes())
            .to_bytes(),
    );
    SignedApproval { body, signature }
}
fn p4_approve(v: &mut RewindVault, ticket: SignedApproval) {
    context("verifier.testnet", 0, 4);
    v.approve_signed_payment(ticket);
}
#[test]
fn sentinel_signed_payment_settles_once_with_existing_accounting() {
    let mut v = p4_setup();
    p4_approve(&mut v, p4_ticket(1, 0));
    context("executor.testnet", 0, 5);
    v.settle_fenced_payment("pay".into(), U64(0));
    assert!(callback(&mut v, "pay", true));
    invariant(&v);
    assert_eq!(task(&v).sentinel.unwrap().last_nonce, 1);
}
#[test]
#[should_panic(expected = "Signed approval required")]
fn sentinel_legacy_fenced_approval_bypass_rejected() {
    let mut v = p4_setup();
    fenced_approve(&mut v, "pay", 0);
}
#[test]
#[should_panic(expected = "Verifier only")]
fn sentinel_requester_cannot_submit_own_approval() {
    let mut v = p4_setup();
    context("executor.testnet", 0, 4);
    v.approve_signed_payment(p4_ticket(1, 0));
}
#[test]
#[should_panic(expected = "Forged sentinel approval")]
fn sentinel_worker_signature_cannot_authorize_payment() {
    let mut v = p4_setup();
    p4_approve(&mut v, p4_sign(p4_ticket(1, 0).body, 1));
}
#[test]
#[should_panic(expected = "nonce mismatch")]
fn sentinel_approval_nonce_replay_rejected() {
    let mut v = p4_setup();
    p4_approve(&mut v, p4_ticket(1, 0));
    p4_approve(&mut v, p4_ticket(1, 0));
}
#[test]
#[should_panic(expected = "Approval expired")]
fn sentinel_expired_ticket_rejected() {
    let mut v = p4_setup();
    let mut body = p4_ticket(1, 0).body;
    body.expires_at = 4;
    p4_approve(&mut v, p4_sign(body, 9));
}
#[test]
#[should_panic(expected = "Signed approval expired")]
fn sentinel_approved_ticket_cannot_be_settled_after_expiry() {
    let mut v = p4_setup();
    p4_approve(&mut v, p4_ticket(1, 0));
    context("executor.testnet", 0, 100);
    v.settle_fenced_payment("pay".into(), U64(0));
}
#[test]
#[should_panic(expected = "Approval domain mismatch")]
fn sentinel_cross_deployment_replay_rejected() {
    let mut v = p4_setup();
    let mut body = p4_ticket(1, 0).body;
    body.domain.deployment = "other-run".into();
    p4_approve(&mut v, p4_sign(body, 9));
}
#[test]
#[should_panic(expected = "Wrong approval recipient")]
fn sentinel_signature_cannot_change_reserved_recipient() {
    let mut v = p4_setup();
    let mut body = p4_ticket(1, 0).body;
    body.recipient = "bob.testnet".into();
    p4_approve(&mut v, p4_sign(body, 9));
}
#[test]
#[should_panic(expected = "Approval budget exceeded")]
fn sentinel_over_budget_signed_ticket_rejected() {
    let mut v = p4_setup();
    let mut body = p4_ticket(1, 0).body;
    body.amount = (7 * N).to_string();
    p4_approve(&mut v, p4_sign(body, 9));
}
#[test]
#[should_panic(expected = "Wrong approval amount")]
fn sentinel_signature_cannot_change_reserved_amount() {
    let mut v = p4_setup();
    let mut body = p4_ticket(1, 0).body;
    body.amount = (2 * N).to_string();
    p4_approve(&mut v, p4_sign(body, 9));
}
#[test]
#[should_panic(expected = "Task paused")]
fn guardian_pause_blocks_signed_dispatch() {
    let mut v = p4_setup();
    p4_approve(&mut v, p4_ticket(1, 0));
    context("guardian.testnet", 0, 5);
    v.set_task_paused("task".into(), true);
    context("executor.testnet", 0, 6);
    v.settle_fenced_payment("pay".into(), U64(0));
}
#[test]
#[should_panic(expected = "Quarantine revoked approval")]
fn guardian_release_does_not_resurrect_old_approval() {
    let mut v = p4_setup();
    p4_approve(&mut v, p4_ticket(1, 0));
    context("guardian.testnet", 0, 5);
    v.set_task_paused("task".into(), true);
    context("admin.testnet", 0, 6);
    v.set_task_paused("task".into(), false);
    context("executor.testnet", 0, 7);
    v.settle_fenced_payment("pay".into(), U64(0));
}
#[test]
#[should_panic(expected = "Stale security revision")]
fn guardian_prequarantine_unconsumed_ticket_rejected_after_release() {
    let mut v = p4_setup();
    context("guardian.testnet", 0, 5);
    v.set_task_paused("task".into(), true);
    context("admin.testnet", 0, 6);
    v.set_task_paused("task".into(), false);
    context("verifier.testnet", 0, 7);
    v.approve_signed_payment(p4_ticket(1, 0));
}
#[test]
#[should_panic(expected = "Owner only")]
fn guardian_cannot_unpause_its_own_quarantine() {
    let mut v = p4_setup();
    context("guardian.testnet", 0, 5);
    v.set_task_paused("task".into(), true);
    v.set_task_paused("task".into(), false);
}
#[test]
#[should_panic(expected = "Guardian or owner only")]
fn worker_cannot_pause_other_tasks() {
    let mut v = p4_setup();
    context("executor.testnet", 0, 5);
    v.set_task_paused("task".into(), true);
}
#[test]
fn guardian_scoped_pause_preserves_other_task_and_refunds() {
    let mut v = p4_setup();
    create(&mut v, "other");
    context("guardian.testnet", 0, 5);
    v.set_task_paused("task".into(), true);
    assert!(!v.get_task("other".into()).unwrap().paused);
    context("depositor.testnet", 0, 6);
    v.cancel_payment("pay".into());
    context("depositor.testnet", OP_STORAGE_BOND, EXPIRY);
    v.refund("task".into(), "refund".into());
    assert!(callback(&mut v, "refund", true));
    assert_eq!(task(&v).refunded, U128(FUND));
}
#[test]
fn guardian_quarantine_keeps_dispatched_callbacks_live() {
    let mut v = p4_setup();
    p4_approve(&mut v, p4_ticket(1, 0));
    context("executor.testnet", 0, 5);
    v.settle_fenced_payment("pay".into(), U64(0));
    context("guardian.testnet", 0, 6);
    v.set_task_paused("task".into(), true);
    assert!(callback(&mut v, "pay", true));
    invariant(&v);
}
#[test]
#[should_panic(expected = "Self-issued")]
fn sentinel_cannot_be_configured_as_a_worker_key() {
    let mut v = fenced_setup();
    let mut policy = p4_policy();
    policy.public_key = policy.worker_keys[0].clone();
    context("depositor.testnet", SENTINEL_STORAGE_BOND, 1);
    v.configure_sentinel("task".into(), policy);
}
