//! Deterministic independent approval. Risk scores are deliberately not an input.
use crate::*;
use anyhow::{Result, ensure};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
pub use phoenix_security_types::{
    Action, ApprovalBody, ApprovalPolicy, MAX_APPROVAL_NS, RecoveryReceiptBody, SignedApproval,
    SignedRecoveryReceipt, VerifiedSettlementOutcome,
};
use serde::{Deserialize, Serialize};

pub fn sign_approval(body: ApprovalBody, key: &SigningKey) -> SignedApproval {
    SignedApproval {
        signature: hex(&key.sign(&body.signing_bytes()).to_bytes()),
        body,
    }
}
pub fn verify_approval(ticket: &SignedApproval, policy: &ApprovalPolicy, now: u64) -> Result<()> {
    policy
        .check(&ticket.body, now)
        .map_err(anyhow::Error::msg)?;
    let key = VerifyingKey::from_bytes(&unhex::<32>(&policy.public_key)?)?;
    key.verify_strict(
        &ticket.body.signing_bytes(),
        &Signature::from_bytes(&unhex::<64>(&ticket.signature)?),
    )?;
    Ok(())
}

/// Finalized REWIND view plus the block identity at which Sentinel observed it.
/// The receipt signs a hash of these fields; Core verifies the Sentinel signature
/// and its own transition, while the public verifier can recheck this evidence.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FinalizedSettlementEvidence {
    pub task_id: String,
    pub settlement_reference: String,
    pub outcome: PaymentState,
    pub recipient: String,
    pub amount: String,
    pub execution_epoch: Option<u64>,
    pub block_height: u64,
    pub block_hash: String,
}

pub struct RecoveryReceiptReview<'a> {
    pub checkpoint: &'a SignedCheckpoint,
    pub active: &'a Snapshot,
    pub settlement: &'a Payment,
    pub evidence: &'a FinalizedSettlementEvidence,
    pub security_revision: u64,
}

/// Independently attest a successful stable payment only after checking the
/// signed recovery checkpoint, active backup epoch, pinned payment intent and
/// finalized REWIND operation evidence.
impl Sentinel {
    pub fn recovery_receipt(
        &self,
        review: RecoveryReceiptReview<'_>,
    ) -> Result<SignedRecoveryReceipt> {
        let RecoveryReceiptReview {
            checkpoint,
            active,
            settlement,
            evidence,
            security_revision,
        } = review;
        ensure!(
            self.plan.domain == self.policy.domain,
            "Sentinel domain mismatch"
        );
        ensure!(
            worker_key(&self.key) == self.policy.public_key,
            "Sentinel signer mismatch"
        );
        checkpoint.verify(&self.plan, active.now)?;
        ensure!(
            checkpoint.body.epoch.checked_add(1) == Some(active.epoch)
                && checkpoint.body.worker_key != active.worker_key,
            "Recovery receipt epoch transition mismatch"
        );
        ensure!(
            active.status == AgentStatus::Running
                && self.plan.worker_keys.contains(&active.worker_key)
                && self.plan.worker_keys.contains(&checkpoint.body.worker_key),
            "Recovery receipt worker identity mismatch"
        );
        ensure!(
            settlement.task_id == self.plan.domain.task_id
                && settlement.state == PaymentState::Succeeded,
            "Settlement is not a successful task payment"
        );
        // REWIND clears Operation.approved after the private transfer callback
        // finalizes either outcome. For Succeeded, the finalized on-chain state
        // proves settlement passed the approval gate; this live flag is expected
        // to be false and must not be used as historical approval evidence.
        ensure!(
            evidence.task_id == settlement.task_id
                && evidence.outcome == PaymentState::Succeeded
                && evidence.recipient == settlement.recipient
                && evidence.amount == settlement.amount
                && evidence.execution_epoch == settlement.epoch
                && evidence.block_height > 0
                && !evidence.block_hash.is_empty()
                && evidence.block_hash.len() <= 64,
            "Finalized settlement evidence mismatch"
        );
        let effect = self
            .plan
            .effects
            .iter()
            .find(|effect| {
                self.plan
                    .payment_id(effect)
                    .is_ok_and(|id| id == evidence.settlement_reference)
            })
            .ok_or_else(|| anyhow::anyhow!("Unknown settlement reference"))?;
        ensure!(
            settlement.recipient == effect.recipient
                && settlement.amount == effect.amount
                && settlement.commitment == evidence.settlement_reference,
            "Settlement differs from pinned task effect"
        );
        ensure!(
            settlement.epoch == Some(checkpoint.body.epoch)
                || settlement.epoch == Some(active.epoch),
            "Settlement is outside the recovery epochs"
        );

        let evidence_hash = digest(&serde_json::to_vec(evidence)?);
        let expires_at = active
            .now
            .checked_add(MAX_APPROVAL_NS)
            .ok_or_else(|| anyhow::anyhow!("Recovery receipt expiry overflow"))?;
        let body = RecoveryReceiptBody {
            domain: self.plan.domain.clone(),
            task_id: self.plan.domain.task_id.clone(),
            primary_identity: checkpoint.body.worker_key.clone(),
            backup_identity: active.worker_key.clone(),
            checkpoint_hash: checkpoint.digest()?,
            epoch_from: checkpoint.body.epoch,
            epoch_to: active.epoch,
            settlement_reference: evidence.settlement_reference.clone(),
            settlement_outcome: VerifiedSettlementOutcome::Succeeded,
            settlement_evidence_hash: evidence_hash,
            settlement_block_height: evidence.block_height,
            security_revision,
            nonce: self
                .policy
                .last_nonce
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("Recovery receipt nonce overflow"))?,
            issued_at: active.now,
            expires_at,
        };
        body.validate_at(active.now).map_err(anyhow::Error::msg)?;
        Ok(SignedRecoveryReceipt {
            signature: hex(&self.key.sign(&body.signing_bytes()).to_bytes()),
            body,
        })
    }
}

/// Verify a historical public receipt. Expiry and nonce are submission controls;
/// they do not invalidate an already finalized, signed receipt after the fact.
pub fn verify_recovery_receipt(
    receipt: &SignedRecoveryReceipt,
    policy: &ApprovalPolicy,
) -> Result<()> {
    receipt
        .body
        .validate_structure()
        .map_err(anyhow::Error::msg)?;
    ensure!(
        receipt.body.domain == policy.domain,
        "Receipt domain mismatch"
    );
    let key = VerifyingKey::from_bytes(&unhex::<32>(&policy.public_key)?)?;
    key.verify_strict(
        &receipt.body.signing_bytes(),
        &Signature::from_bytes(&unhex::<64>(&receipt.signature)?),
    )?;
    Ok(())
}

pub fn verify_recovery_receipt_evidence(
    receipt: &SignedRecoveryReceipt,
    evidence: &FinalizedSettlementEvidence,
    policy: &ApprovalPolicy,
) -> Result<()> {
    verify_recovery_receipt(receipt, policy)?;
    ensure!(
        evidence.task_id == receipt.body.task_id
            && evidence.settlement_reference == receipt.body.settlement_reference
            && evidence.outcome == PaymentState::Succeeded
            && evidence.block_height == receipt.body.settlement_block_height
            && digest(&serde_json::to_vec(evidence)?) == receipt.body.settlement_evidence_hash,
        "Settlement evidence does not match receipt"
    );
    Ok(())
}
#[derive(Clone, Debug)]
pub struct RecipientFacts {
    pub account_id: String,
    pub limit: u128,
    pub committed: u128,
}
#[derive(Clone, Debug)]
pub struct TaskFacts {
    pub executor: String,
    pub verifier: String,
    pub epoch: u64,
    pub revision: u64,
    pub paused: bool,
    pub expires_at: u64,
    pub refund_started: bool,
    pub funded: u128,
    pub available: u128,
    pub reserved: u128,
    pub pending: u128,
    pub paid: u128,
    pub refunded: u128,
    pub recipients: Vec<RecipientFacts>,
}
pub struct PaymentReview<'a> {
    pub checkpoint: &'a SignedCheckpoint,
    pub snapshot: &'a Snapshot,
    pub session: &'a Session,
    pub effect: &'a Effect,
    pub task: &'a TaskFacts,
    pub operation: &'a Payment,
    pub last_nonce: u64,
}
pub struct RecoveryReview<'a> {
    pub checkpoint: &'a SignedCheckpoint,
    pub snapshot: &'a Snapshot,
    pub requester: &'a str,
    pub verifier: &'a str,
    pub backup: &'a str,
    pub revision: u64,
    pub last_nonce: u64,
}
/// This signer belongs to SENTINEL, not the AI worker/coordinator. Deploy the
/// interface behind independent custody; the local harness uses separate keys.
pub struct Sentinel {
    pub plan: Plan,
    pub policy: ApprovalPolicy,
    key: SigningKey,
}
impl Sentinel {
    pub fn new(plan: Plan, policy: ApprovalPolicy, key: SigningKey) -> Result<Self> {
        plan.validate()?;
        // Policy storage starts at nonce zero on chain, but an independently
        // running Sentinel must be able to reload its current nonzero chain nonce
        // after prior approvals. Validate immutable policy fields separately.
        let mut initial_policy = policy.clone();
        initial_policy.last_nonce = 0;
        initial_policy.validate().map_err(anyhow::Error::msg)?;
        ensure!(
            plan.domain == policy.domain && worker_key(&key) == policy.public_key,
            "Sentinel configuration mismatch"
        );
        ensure!(
            !plan.worker_keys.contains(&policy.public_key),
            "Self-issued sentinel key"
        );
        ensure!(
            plan.worker_keys == policy.worker_keys,
            "Sentinel worker registry mismatch"
        );
        ensure!(!key.verifying_key().is_weak(), "Weak sentinel key");
        Ok(Self { plan, policy, key })
    }
    fn body(
        &self,
        cp: &SignedCheckpoint,
        snapshot: &Snapshot,
        requester: &str,
        revision: u64,
        last_nonce: u64,
    ) -> Result<ApprovalBody> {
        verify_anchor(cp, &self.plan, snapshot)?;
        ensure!(
            !snapshot.paused && snapshot.status != AgentStatus::Contained,
            "Agent quarantined or paused"
        );
        ensure!(
            self.plan.worker_keys.contains(&snapshot.worker_key),
            "Unknown agent identity"
        );
        Ok(ApprovalBody {
            domain: self.plan.domain.clone(),
            action: Action::Payment,
            requester: requester.into(),
            subject_key: snapshot.worker_key.clone(),
            epoch: snapshot.epoch,
            security_revision: revision,
            checkpoint_digest: cp.digest()?,
            operation_id: String::new(),
            recipient: String::new(),
            amount: "0".into(),
            commitment: String::new(),
            nonce: last_nonce
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("Approval nonce overflow"))?,
            issued_at: snapshot.now,
            expires_at: snapshot
                .now
                .checked_add(MAX_APPROVAL_NS)
                .ok_or_else(|| anyhow::anyhow!("Approval expiry overflow"))?
                .min(cp.body.expires_at),
        })
    }
    fn finish(&self, body: ApprovalBody, last_nonce: u64) -> Result<SignedApproval> {
        let mut policy = self.policy.clone();
        policy.last_nonce = last_nonce;
        policy
            .check(&body, body.issued_at)
            .map_err(anyhow::Error::msg)?;
        Ok(sign_approval(body, &self.key))
    }
    pub fn payment(&self, review: PaymentReview<'_>) -> Result<SignedApproval> {
        let PaymentReview {
            checkpoint: cp,
            snapshot,
            session,
            effect,
            task,
            operation: op,
            last_nonce,
        } = review;
        ensure!(
            snapshot.status == AgentStatus::Running
                && snapshot.now.saturating_sub(snapshot.heartbeat_at) < snapshot.timeout_ns,
            "Agent not live"
        );
        ensure!(
            session.epoch == snapshot.epoch
                && session.worker_key == snapshot.worker_key
                && session.checkpoint_digest == cp.digest()?,
            "Action fence mismatch"
        );
        ensure!(
            !task.paused
                && !task.refund_started
                && snapshot.now < task.expires_at
                && task.epoch == snapshot.epoch,
            "Task not active"
        );
        ensure!(
            task.executor == self.policy.requester
                && task.verifier == self.policy.verifier
                && task.executor != task.verifier,
            "Self-issued or mismatched NEAR authorization"
        );
        ensure!(
            cp.body.state.requested_effects.contains(&effect.name),
            "Task did not request effect"
        );
        let id = self.plan.payment_id(effect)?;
        let amount = effect.amount.parse::<u128>()?;
        ensure!(
            op.task_id == self.plan.domain.task_id
                && op.state == PaymentState::Reserved
                && op.recipient == effect.recipient
                && op.amount == effect.amount
                && op.commitment == id,
            "Reserved payment mismatch"
        );
        let recipient = task
            .recipients
            .iter()
            .find(|r| r.account_id == effect.recipient)
            .ok_or_else(|| anyhow::anyhow!("Recipient not permitted"))?;
        ensure!(
            recipient.committed <= recipient.limit
                && recipient.committed >= amount
                && task.reserved >= amount,
            "Recipient/task budget mismatch"
        );
        let total = [
            task.available,
            task.reserved,
            task.pending,
            task.paid,
            task.refunded,
        ]
        .iter()
        .try_fold(0u128, |sum, n| sum.checked_add(*n))
        .ok_or_else(|| anyhow::anyhow!("Task accounting overflow"))?;
        ensure!(total == task.funded, "Task backing mismatch");
        let mut body = self.body(cp, snapshot, &task.executor, task.revision, last_nonce)?;
        body.action = Action::Payment;
        body.operation_id = id.clone();
        body.recipient = effect.recipient.clone();
        body.amount = effect.amount.clone();
        body.commitment = id;
        self.finish(body, last_nonce)
    }
    pub fn recovery(&self, review: RecoveryReview<'_>) -> Result<SignedApproval> {
        let RecoveryReview {
            checkpoint: cp,
            snapshot,
            requester,
            verifier,
            backup,
            revision,
            last_nonce,
        } = review;
        ensure!(
            requester == self.policy.requester
                && verifier == self.policy.verifier
                && requester != verifier,
            "Self-issued or mismatched NEAR authorization"
        );
        ensure!(
            snapshot.status == AgentStatus::Crashed
                && cp.body.epoch == snapshot.epoch
                && snapshot.backups.contains(&backup.to_owned()),
            "Recovery not permitted"
        );
        let mut body = self.body(cp, snapshot, requester, revision, last_nonce)?;
        body.action = Action::Recovery;
        body.operation_id = cp.digest()?;
        body.commitment = cp.digest()?;
        body.recipient = backup.into();
        self.finish(body, last_nonce)
    }
    pub fn high_risk(
        &self,
        cp: &SignedCheckpoint,
        snapshot: &Snapshot,
        body: ApprovalBody,
        last_nonce: u64,
    ) -> Result<SignedApproval> {
        verify_anchor(cp, &self.plan, snapshot)?;
        ensure!(
            !snapshot.paused
                && snapshot.status == AgentStatus::Running
                && snapshot.now.saturating_sub(snapshot.heartbeat_at) < snapshot.timeout_ns,
            "Agent not live"
        );
        ensure!(
            matches!(body.action, Action::ExternalCall | Action::DataExport),
            "Use dedicated financial/recovery approval"
        );
        ensure!(
            body.domain == self.plan.domain
                && body.subject_key == snapshot.worker_key
                && body.epoch == snapshot.epoch
                && cp.body.epoch == snapshot.epoch
                && body.checkpoint_digest == cp.digest()?,
            "High-risk action identity mismatch"
        );
        ensure!(body.issued_at == snapshot.now, "Fresh approval required");
        self.finish(body, last_nonce)
    }
}
