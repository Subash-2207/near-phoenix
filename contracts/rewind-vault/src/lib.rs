use near_sdk::collections::LookupMap;
use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, AccountId, Gas, GasWeight, NearToken, PanicOnDefault, PromiseError};
use phoenix_security_types::{decode_hex, Action, ApprovalPolicy, SignedApproval};

pub const TASK_STORAGE_BOND: u128 = 25_000_000_000_000_000_000_000; // 0.025 NEAR
pub const SENTINEL_STORAGE_BOND: u128 = 40_000_000_000_000_000_000_000;
pub const OP_STORAGE_BOND: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR
pub const UNCERTAIN_AFTER_NS: u64 = 3_600_000_000_000;
const MAX_DURATION_NS: u64 = 30 * 86_400_000_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum OperationState {
    Reserved,
    Pending,
    Uncertain,
    Succeeded,
    Failed,
    Cancelled,
}
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum OperationKind {
    Payment,
    Refund,
}
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct RecipientBudget {
    pub account_id: AccountId,
    pub limit: U128,
}
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Recipient {
    pub account_id: AccountId,
    pub limit: U128,
    /// Reserved + pending + paid. Failed and cancelled payments release this commitment.
    pub committed: U128,
}
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Task {
    pub depositor: AccountId,
    pub executor: AccountId,
    pub verifier: AccountId,
    pub recipients: Vec<Recipient>,
    pub expires_at: U64,
    pub funded: U128,
    pub available: U128,
    pub reserved: U128,
    pub pending: U128,
    pub paid: U128,
    pub refunded: U128,
    pub refund_authorized: bool,
    /// A refund permanently closes the task to new payments, even if that refund fails.
    pub refund_started: bool,
    /// Opt-in epoch fencing; old APIs cannot bypass it.
    pub execution_epoch: Option<U64>,
    pub sentinel: Option<ApprovalPolicy>,
    pub paused: bool,
    pub security_revision: U64,
}
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Operation {
    pub task_id: String,
    pub recipient: AccountId,
    pub amount: U128,
    pub kind: OperationKind,
    pub state: OperationState,
    /// Opaque SHA-256 commitment reviewed by verifier. This is not itself a proof.
    pub commitment: String,
    pub approved: bool,
    pub pending_at: U64,
    pub execution_epoch: Option<U64>,
    pub approval_expires_at: Option<U64>,
    pub approval_revision: U64,
}
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct RewindVault {
    owner: AccountId,
    guardian: AccountId,
    safe_mode: bool,
    /// All unfinalized principal, including transfers awaiting callbacks.
    liability: u128,
    in_flight: u128,
    tasks: LookupMap<String, Task>,
    operations: LookupMap<String, Operation>,
}
#[near]
impl RewindVault {
    #[init]
    pub fn new(owner: AccountId, guardian: AccountId) -> Self {
        Self {
            owner,
            guardian,
            safe_mode: false,
            liability: 0,
            in_flight: 0,
            tasks: LookupMap::new(b"t"),
            operations: LookupMap::new(b"o"),
        }
    }
    /// Caller funds task principal and separate, nonrefundable storage bond.
    #[payable]
    pub fn create_task(
        &mut self,
        task_id: String,
        executor: AccountId,
        verifier: AccountId,
        recipients: Vec<RecipientBudget>,
        escrow_amount: U128,
        expires_at: U64,
    ) {
        self.assert_active();
        valid_id(&task_id);
        assert!(self.tasks.get(&task_id).is_none(), "Task exists");
        assert_ne!(executor, verifier, "Independent verifier required");
        assert!(
            !recipients.is_empty() && recipients.len() <= 8,
            "Use 1 to 8 recipients"
        );
        let duration = expires_at
            .0
            .checked_sub(env::block_timestamp())
            .expect("Expiry in past");
        assert!(
            duration > 0 && duration <= MAX_DURATION_NS,
            "Invalid expiry"
        );
        assert!(escrow_amount.0 > 0, "Positive escrow required");
        assert_eq!(
            env::attached_deposit().as_yoctonear(),
            add(escrow_amount.0, TASK_STORAGE_BOND),
            "Escrow plus task storage bond required"
        );
        let mut sum = 0;
        let mut entries: Vec<Recipient> = Vec::new();
        for r in recipients {
            assert_ne!(
                r.account_id,
                env::current_account_id(),
                "Vault cannot be recipient"
            );
            assert!(r.limit.0 > 0, "Positive budget required");
            assert!(
                !entries.iter().any(|e| e.account_id == r.account_id),
                "Duplicate recipient"
            );
            sum = add(sum, r.limit.0);
            entries.push(Recipient {
                account_id: r.account_id,
                limit: r.limit,
                committed: U128(0),
            });
        }
        assert!(sum <= escrow_amount.0, "Budgets exceed escrow");
        let before = env::storage_usage();
        self.tasks.insert(
            &task_id,
            &Task {
                depositor: env::predecessor_account_id(),
                executor,
                verifier,
                recipients: entries,
                expires_at,
                funded: escrow_amount,
                available: escrow_amount,
                reserved: U128(0),
                pending: U128(0),
                paid: U128(0),
                refunded: U128(0),
                refund_authorized: false,
                refund_started: false,
                execution_epoch: None,
                sentinel: None,
                paused: false,
                security_revision: U64(0),
            },
        );
        self.liability = add(self.liability, escrow_amount.0);
        storage_covered(before, TASK_STORAGE_BOND);
        event("task_funded", &task_id);
    }
    /// Fencing is enabled by the depositor before any principal is spent.
    pub fn enable_task_fencing(&mut self, task_id: String) {
        let mut t = self.task(&task_id);
        assert_eq!(env::predecessor_account_id(), t.depositor, "Depositor only");
        assert!(t.execution_epoch.is_none(), "Already fenced");
        assert_eq!(t.available, t.funded, "Task already used");
        assert!(!t.refund_started, "Task refunding");
        t.execution_epoch = Some(U64(0));
        self.save_task(&task_id, &t);
    }

    /// Only the independent verifier can fence an old coordinator session.
    /// Pending native transfers still reconcile through their authentic callbacks.
    pub fn advance_task_epoch(&mut self, task_id: String, expected_epoch: U64) {
        let mut t = self.task(&task_id);
        assert_eq!(env::predecessor_account_id(), t.verifier, "Verifier only");
        assert_eq!(t.execution_epoch, Some(expected_epoch), "Stale task epoch");
        t.execution_epoch = Some(U64(expected_epoch
            .0
            .checked_add(1)
            .expect("Epoch overflow")));
        self.save_task(&task_id, &t);
    }

    /// Separate storage funding; immutable opt-in, no downgrade endpoint.
    #[payable]
    pub fn configure_sentinel(&mut self, task_id: String, policy: ApprovalPolicy) {
        let mut t = self.task(&task_id);
        assert_eq!(env::predecessor_account_id(), t.depositor, "Depositor only");
        assert!(
            t.sentinel.is_none() && t.execution_epoch.is_some(),
            "Fresh fenced policy required"
        );
        assert_eq!(t.available, t.funded, "Task already used");
        assert!(!t.refund_started, "Task refunding");
        assert_eq!(
            env::attached_deposit().as_yoctonear(),
            SENTINEL_STORAGE_BOND,
            "Sentinel storage bond required"
        );
        policy.validate().expect("Invalid sentinel policy");
        assert_eq!(
            policy.requester,
            t.executor.as_str(),
            "Wrong policy executor"
        );
        assert_eq!(
            policy.verifier,
            t.verifier.as_str(),
            "Wrong policy verifier"
        );
        assert_eq!(
            policy.domain.vault_id,
            env::current_account_id().as_str(),
            "Wrong vault domain"
        );
        assert_eq!(policy.domain.task_id, task_id, "Wrong task domain");
        let before = env::storage_usage();
        t.sentinel = Some(policy);
        self.save_task(&task_id, &t);
        storage_covered(before, SENTINEL_STORAGE_BOND);
    }

    /// Scoped emergency stop. Refunds, cancellation and authentic callbacks remain live.
    pub fn set_task_paused(&mut self, task_id: String, paused: bool) {
        let caller = env::predecessor_account_id();
        if paused {
            assert!(
                caller == self.guardian || caller == self.owner,
                "Guardian or owner only"
            );
        } else {
            assert_eq!(caller, self.owner, "Owner only");
        }
        let mut t = self.task(&task_id);
        if paused && !t.paused {
            t.security_revision = U64(t
                .security_revision
                .0
                .checked_add(1)
                .expect("Revision overflow"));
        }
        t.paused = paused;
        self.save_task(&task_id, &t);
        event(
            if paused {
                "task_quarantined"
            } else {
                "task_released"
            },
            &task_id,
        );
    }

    /// Requires BOTH the designated NEAR verifier and its independent signed ticket.
    pub fn approve_signed_payment(&mut self, approval: SignedApproval) {
        let body = &approval.body;
        let mut t = self.task(&body.domain.task_id);
        assert_eq!(env::predecessor_account_id(), t.verifier, "Verifier only");
        let policy = t.sentinel.as_mut().expect("Sentinel not configured");
        policy
            .check(body, env::block_timestamp())
            .expect("Invalid signed approval");
        assert_eq!(body.action, Action::Payment, "Wrong approval action");
        assert_eq!(
            body.requester,
            t.executor.as_str(),
            "Wrong approval requester"
        );
        assert_eq!(Some(U64(body.epoch)), t.execution_epoch, "Stale task epoch");
        assert_eq!(
            body.security_revision, t.security_revision.0,
            "Stale security revision"
        );
        let op = self.operation(&body.operation_id);
        assert_eq!(op.task_id, body.domain.task_id, "Wrong operation task");
        assert_eq!(
            op.recipient.as_str(),
            body.recipient,
            "Wrong approval recipient"
        );
        assert_eq!(
            op.amount.0.to_string(),
            body.amount,
            "Wrong approval amount"
        );
        assert_eq!(op.commitment, body.commitment, "Wrong approval commitment");
        assert!(
            env::ed25519_verify(
                &decode_hex::<64>(&approval.signature).expect("Invalid signature"),
                body.signing_bytes(),
                &decode_hex::<32>(&policy.public_key).expect("Invalid public key")
            ),
            "Forged sentinel approval"
        );
        self.approve_payment_inner(
            body.operation_id.clone(),
            body.commitment.clone(),
            Some(U64(body.epoch)),
            Some(U64(body.expires_at)),
        );
        policy.last_nonce = body.nonce;
        self.save_task(&body.domain.task_id, &t);
        event("signed_payment_approved", &body.operation_id);
    }

    #[payable]
    pub fn reserve_payment(
        &mut self,
        task_id: String,
        operation_id: String,
        recipient: AccountId,
        amount: U128,
        commitment: String,
    ) {
        self.reserve_payment_inner(task_id, operation_id, recipient, amount, commitment, None);
    }
    #[payable]
    pub fn reserve_fenced_payment(
        &mut self,
        task_id: String,
        operation_id: String,
        recipient: AccountId,
        amount: U128,
        commitment: String,
        epoch: U64,
    ) {
        self.reserve_payment_inner(
            task_id,
            operation_id,
            recipient,
            amount,
            commitment,
            Some(epoch),
        );
    }
    pub fn approve_payment(&mut self, operation_id: String, expected_commitment: String) {
        self.approve_payment_inner(operation_id, expected_commitment, None, None);
    }
    pub fn approve_fenced_payment(
        &mut self,
        operation_id: String,
        expected_commitment: String,
        epoch: U64,
    ) {
        self.approve_payment_inner(operation_id, expected_commitment, Some(epoch), None);
    }
    pub fn settle_payment(&mut self, operation_id: String) {
        self.settle_payment_inner(operation_id, None);
    }
    pub fn settle_fenced_payment(&mut self, operation_id: String, epoch: U64) {
        self.settle_payment_inner(operation_id, Some(epoch));
    }

    fn reserve_payment_inner(
        &mut self,
        task_id: String,
        operation_id: String,
        recipient: AccountId,
        amount: U128,
        commitment: String,
        execution_epoch: Option<U64>,
    ) {
        self.assert_active();
        self.assert_new_operation(&operation_id);
        assert_eq!(
            env::attached_deposit().as_yoctonear(),
            OP_STORAGE_BOND,
            "Operation storage bond required"
        );
        assert!(
            commitment.len() == 64 && commitment.bytes().all(|b| b.is_ascii_hexdigit()),
            "Expected SHA-256 hex commitment"
        );
        let mut t = self.task(&task_id);
        assert!(!t.paused, "Task paused");
        assert_eq!(t.execution_epoch, execution_epoch, "Stale task epoch");
        assert_eq!(env::predecessor_account_id(), t.executor, "Executor only");
        assert!(!t.refund_started, "Task refunding");
        assert!(env::block_timestamp() < t.expires_at.0, "Task expired");
        assert!(amount.0 > 0, "Positive payment required");
        assert!(amount.0 <= t.available.0, "Insufficient task balance");
        let budget = t
            .recipients
            .iter_mut()
            .find(|r| r.account_id == recipient)
            .expect("Unauthorized recipient");
        let committed = add(budget.committed.0, amount.0);
        assert!(committed <= budget.limit.0, "Recipient budget exceeded");
        budget.committed = U128(committed);
        t.available = U128(sub(t.available.0, amount.0));
        t.reserved = U128(add(t.reserved.0, amount.0));
        let before = env::storage_usage();
        self.save_task(&task_id, &t);
        self.operations.insert(
            &operation_id,
            &Operation {
                task_id,
                recipient,
                amount,
                kind: OperationKind::Payment,
                state: OperationState::Reserved,
                commitment: commitment.to_ascii_lowercase(),
                approved: false,
                pending_at: U64(0),
                execution_epoch,
                approval_expires_at: None,
                approval_revision: t.security_revision,
            },
        );
        storage_covered(before, OP_STORAGE_BOND);
        event("payment_reserved", &operation_id);
    }
    /// Verifier decision is bound to the exact task, amount, recipient and commitment in this operation.
    fn approve_payment_inner(
        &mut self,
        operation_id: String,
        expected_commitment: String,
        execution_epoch: Option<U64>,
        signed_expiry: Option<U64>,
    ) {
        self.assert_active();
        let mut op = self.operation(&operation_id);
        let t = self.task(&op.task_id);
        assert!(!t.paused, "Task paused");
        assert!(
            t.sentinel.is_none() || signed_expiry.is_some(),
            "Signed approval required"
        );
        assert_eq!(t.execution_epoch, execution_epoch, "Stale task epoch");
        assert_eq!(env::predecessor_account_id(), t.verifier, "Verifier only");
        assert_eq!(op.state, OperationState::Reserved, "Operation not reserved");
        assert_eq!(op.kind, OperationKind::Payment, "Not a payment");
        assert!(
            !op.approved
                || op.execution_epoch != execution_epoch
                || signed_expiry.is_some()
                || op.approval_revision != t.security_revision,
            "Already approved"
        );
        op.execution_epoch = execution_epoch;
        assert!(env::block_timestamp() < t.expires_at.0, "Task expired");
        assert_eq!(
            expected_commitment.to_ascii_lowercase(),
            op.commitment,
            "Commitment mismatch"
        );
        op.approved = true;
        op.approval_expires_at = signed_expiry;
        op.approval_revision = t.security_revision;
        self.operations.insert(&operation_id, &op);
        event("payment_approved", &operation_id);
    }
    fn settle_payment_inner(&mut self, operation_id: String, execution_epoch: Option<U64>) {
        self.assert_active();
        let mut op = self.operation(&operation_id);
        let mut t = self.task(&op.task_id);
        assert!(!t.paused, "Task paused");
        assert_eq!(t.execution_epoch, execution_epoch, "Stale task epoch");
        assert_eq!(env::predecessor_account_id(), t.executor, "Executor only");
        assert_eq!(op.state, OperationState::Reserved, "Operation not reserved");
        assert_eq!(op.kind, OperationKind::Payment, "Not a payment");
        assert_eq!(
            op.execution_epoch, execution_epoch,
            "Payment approval epoch mismatch"
        );
        assert!(op.approved, "Verified approval required");
        assert_eq!(
            op.approval_revision, t.security_revision,
            "Quarantine revoked approval"
        );
        if t.sentinel.is_some() {
            assert!(
                env::block_timestamp()
                    < op.approval_expires_at.expect("Signed approval required").0,
                "Signed approval expired"
            );
        }
        assert!(env::block_timestamp() < t.expires_at.0, "Task expired");
        self.assert_transfer_capacity();
        t.reserved = U128(sub(t.reserved.0, op.amount.0));
        t.pending = U128(add(t.pending.0, op.amount.0));
        self.begin_transfer(&operation_id, op.task_id.clone(), &mut op, t)
    }
    /// Reserved payments can be cancelled during safe mode. Dispatched transfers cannot be recalled.
    pub fn cancel_payment(&mut self, operation_id: String) {
        let mut op = self.operation(&operation_id);
        let mut t = self.task(&op.task_id);
        let caller = env::predecessor_account_id();
        assert!(
            caller == t.executor || caller == t.depositor,
            "Depositor or executor only"
        );
        assert_eq!(op.state, OperationState::Reserved, "Operation not reserved");
        assert_eq!(op.kind, OperationKind::Payment, "Not a payment");
        t.reserved = U128(sub(t.reserved.0, op.amount.0));
        t.available = U128(add(t.available.0, op.amount.0));
        release_budget(&mut t, &op);
        op.state = OperationState::Cancelled;
        op.approved = false;
        self.save_task(&op.task_id, &t);
        self.operations.insert(&operation_id, &op);
        event("payment_cancelled", &operation_id);
    }
    /// Verifier may authorize early refund, always to the immutable original depositor.
    pub fn authorize_refund(&mut self, task_id: String) {
        let mut t = self.task(&task_id);
        assert_eq!(env::predecessor_account_id(), t.verifier, "Verifier only");
        t.refund_authorized = true;
        self.save_task(&task_id, &t);
        event("refund_authorized", &task_id);
    }
    #[payable]
    pub fn refund(&mut self, task_id: String, operation_id: String) {
        self.assert_new_operation(&operation_id);
        assert_eq!(
            env::attached_deposit().as_yoctonear(),
            OP_STORAGE_BOND,
            "Operation storage bond required"
        );
        let mut t = self.task(&task_id);
        assert_eq!(env::predecessor_account_id(), t.depositor, "Depositor only");
        assert!(
            t.refund_authorized || env::block_timestamp() >= t.expires_at.0,
            "Refund not authorized"
        );
        assert!(
            t.reserved.0 == 0 && t.pending.0 == 0,
            "Unresolved operations"
        );
        assert!(t.available.0 > 0, "Nothing to refund");
        self.assert_transfer_capacity();
        let before = env::storage_usage();
        let mut op = Operation {
            task_id: task_id.clone(),
            recipient: t.depositor.clone(),
            amount: t.available,
            kind: OperationKind::Refund,
            state: OperationState::Reserved,
            commitment: "0".repeat(64),
            approved: true,
            pending_at: U64(0),
            execution_epoch: t.execution_epoch,
            approval_expires_at: None,
            approval_revision: t.security_revision,
        };
        t.refund_started = true;
        t.available = U128(0);
        t.pending = U128(add(t.pending.0, op.amount.0));
        self.begin_transfer(&operation_id, task_id, &mut op, t);
        storage_covered(before, OP_STORAGE_BOND);
    }
    /// Timeout is not evidence of transfer failure: keep funds and budget locked.
    pub fn mark_uncertain(&mut self, operation_id: String) {
        let mut op = self.operation(&operation_id);
        assert_eq!(op.state, OperationState::Pending, "Operation not pending");
        assert!(
            env::block_timestamp().saturating_sub(op.pending_at.0) >= UNCERTAIN_AFTER_NS,
            "Outcome not overdue"
        );
        op.state = OperationState::Uncertain;
        self.operations.insert(&operation_id, &op);
        event("outcome_uncertain", &operation_id);
    }
    /// Reconcile only from the native transfer's chained receipt result. No admin outcome override.
    #[private]
    pub fn on_transfer(&mut self, operation_id: String) -> bool {
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "Private callback"
        );
        assert_eq!(
            env::promise_results_count(),
            1,
            "Exactly one transfer result required"
        );
        let mut op = self.operation(&operation_id);
        assert!(
            matches!(
                op.state,
                OperationState::Pending | OperationState::Uncertain
            ),
            "Operation not pending"
        );
        let success = match env::promise_result_checked(0, 0) {
            Ok(_) => true,
            Err(PromiseError::Failed) => false,
            _ => {
                op.state = OperationState::Uncertain;
                self.operations.insert(&operation_id, &op);
                event("outcome_uncertain", &operation_id);
                return false;
            }
        };
        let mut t = self.task(&op.task_id);
        t.pending = U128(sub(t.pending.0, op.amount.0));
        self.in_flight = sub(self.in_flight, op.amount.0);
        if success {
            self.liability = sub(self.liability, op.amount.0);
            match op.kind {
                OperationKind::Payment => t.paid = U128(add(t.paid.0, op.amount.0)),
                OperationKind::Refund => t.refunded = U128(add(t.refunded.0, op.amount.0)),
            }
            op.state = OperationState::Succeeded;
        } else {
            t.available = U128(add(t.available.0, op.amount.0));
            if op.kind == OperationKind::Payment {
                release_budget(&mut t, &op);
            }
            op.state = OperationState::Failed;
        }
        op.approved = false;
        self.save_task(&op.task_id, &t);
        self.operations.insert(&operation_id, &op);
        event(
            if success {
                "transfer_succeeded"
            } else {
                "transfer_failed"
            },
            &operation_id,
        );
        success
    }
    pub fn set_safe_mode(&mut self, enabled: bool) {
        let caller = env::predecessor_account_id();
        if enabled {
            assert!(
                caller == self.owner || caller == self.guardian,
                "Guardian or owner only"
            );
        } else {
            assert_eq!(caller, self.owner, "Owner only");
        }
        self.safe_mode = enabled;
        event(
            if enabled {
                "safe_mode_enabled"
            } else {
                "safe_mode_disabled"
            },
            "vault",
        );
    }
    pub fn get_task(&self, task_id: String) -> Option<Task> {
        self.tasks.get(&task_id)
    }
    pub fn get_operation(&self, operation_id: String) -> Option<Operation> {
        self.operations.get(&operation_id)
    }
    pub fn accounting(&self) -> (U128, U128) {
        (U128(self.liability), U128(self.in_flight))
    }
    pub fn is_safe_mode(&self) -> bool {
        self.safe_mode
    }
}
impl RewindVault {
    /// Check conservation at every update, before scheduling or reconciling transfers.
    /// Refund closure guarantees that any remaining pending amount is a refund.
    fn save_task(&mut self, id: &String, task: &Task) {
        let unspent = add(add(task.available.0, task.reserved.0), task.pending.0);
        assert_eq!(
            task.funded.0,
            add(unspent, add(task.paid.0, task.refunded.0)),
            "Task principal invariant"
        );
        let mut committed = 0;
        for recipient in &task.recipients {
            assert!(
                recipient.committed.0 <= recipient.limit.0,
                "Budget invariant"
            );
            committed = add(committed, recipient.committed.0);
        }
        let pending_payment = if task.refund_started {
            assert_eq!(task.reserved.0, 0, "Refund reservation invariant");
            0
        } else {
            task.pending.0
        };
        assert_eq!(
            committed,
            add(task.paid.0, add(task.reserved.0, pending_payment)),
            "Task commitment invariant"
        );
        self.tasks.insert(id, task);
    }
    fn assert_active(&self) {
        assert!(!self.safe_mode, "Vault in safe mode");
    }
    fn task(&self, id: &String) -> Task {
        self.tasks.get(id).expect("Unknown task")
    }
    fn operation(&self, id: &String) -> Operation {
        self.operations.get(id).expect("Unknown operation")
    }
    fn assert_new_operation(&self, id: &String) {
        valid_id(id);
        assert!(
            self.operations.get(id).is_none(),
            "Operation ID already used"
        );
    }
    fn assert_transfer_capacity(&self) {
        assert!(
            env::prepaid_gas()
                .as_gas()
                .saturating_sub(env::used_gas().as_gas())
                >= Gas::from_tgas(50).as_gas(),
            "Insufficient callback gas"
        );
        let storage = u128::from(env::storage_usage())
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .expect("Storage overflow");
        assert!(
            env::account_balance().as_yoctonear()
                >= add(
                    sub(self.liability, self.in_flight),
                    add(storage, OP_STORAGE_BOND)
                ),
            "Insufficient vault backing"
        );
    }
    fn begin_transfer(&mut self, id: &String, task_id: String, op: &mut Operation, task: Task) {
        op.state = OperationState::Pending;
        op.pending_at = U64(env::block_timestamp());
        self.in_flight = add(self.in_flight, op.amount.0);
        self.save_task(&task_id, &task);
        self.operations.insert(id, op);
        event("transfer_pending", id);
        // Construct only the actions this vault supports. The SDK's generic
        // Promise dispatcher links every action variant, including host imports
        // for gas keys and universal accounts absent from older sandbox runtimes.
        // State is locked above before either asynchronous receipt is scheduled.
        let transfer = env::promise_batch_create(&op.recipient);
        env::promise_batch_action_transfer(transfer, NearToken::from_yoctonear(op.amount.0));
        let callback = env::promise_batch_then(transfer, &env::current_account_id());
        let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({"operation_id": id}))
            .expect("Callback serialization failed");
        env::promise_batch_action_function_call_weight(
            callback,
            "on_transfer",
            &args,
            NearToken::from_yoctonear(0),
            Gas::from_tgas(20),
            GasWeight(0),
        );
        // Preserve the public API's final callback boolean as the transaction result.
        env::promise_return(callback);
    }
}
fn valid_id(id: &str) {
    assert!(
        !id.is_empty()
            && id.len() <= 64
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c)),
        "Invalid ID"
    );
}
fn add(a: u128, b: u128) -> u128 {
    a.checked_add(b).expect("Amount overflow")
}
fn sub(a: u128, b: u128) -> u128 {
    a.checked_sub(b).expect("Accounting underflow")
}
fn storage_covered(before: u64, bond: u128) {
    let bytes = env::storage_usage().saturating_sub(before);
    assert!(
        u128::from(bytes)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .expect("Storage overflow")
            <= bond,
        "Storage bond insufficient"
    );
}
fn release_budget(t: &mut Task, op: &Operation) {
    let r = t
        .recipients
        .iter_mut()
        .find(|r| r.account_id == op.recipient)
        .expect("Recipient missing");
    r.committed = U128(sub(r.committed.0, op.amount.0));
}
fn event(action: &str, id: &str) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        near_sdk::serde_json::json!({"standard":"rewind","version":"1.0.0","event":action,"data":[{"id":id}]})
    ));
}
#[cfg(test)]
mod tests;
