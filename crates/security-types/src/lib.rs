//! Shared, versioned approval wire format. Enum order is part of the Borsh V1 ABI.
use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};
pub const MAX_APPROVAL_NS: u64 = 60_000_000_000;
#[derive(Clone, Debug, Serialize, Deserialize, BorshSerialize, BorshDeserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Domain {
    pub network: String,
    pub deployment: String,
    pub core_id: String,
    pub vault_id: String,
    pub agent_id: String,
    pub task_id: String,
    pub execution_id: String,
    pub code_digest: String,
    pub policy_digest: String,
}
#[derive(
    Clone, Copy, Debug, Serialize, Deserialize, BorshSerialize, BorshDeserialize, PartialEq, Eq,
)]
pub enum Action {
    Payment,
    Recovery,
    ExternalCall,
    DataExport,
}
#[derive(Clone, Debug, Serialize, Deserialize, BorshSerialize, BorshDeserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ApprovalBody {
    pub domain: Domain,
    pub action: Action,
    pub requester: String,
    pub subject_key: String,
    pub epoch: u64,
    pub security_revision: u64,
    pub checkpoint_digest: String,
    pub operation_id: String,
    pub recipient: String,
    pub amount: String,
    pub commitment: String,
    pub nonce: u64,
    pub issued_at: u64,
    pub expires_at: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
#[serde(deny_unknown_fields)]
pub struct SignedApproval {
    pub body: ApprovalBody,
    pub signature: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct ApprovalPolicy {
    pub domain: Domain,
    pub public_key: String,
    pub requester: String,
    pub verifier: String,
    pub worker_keys: Vec<String>,
    pub last_nonce: u64,
    pub allowed_actions: Vec<Action>,
    pub allowed_recipients: Vec<String>,
    pub max_payment: String,
}

/// A signed attestation that an independently verified REWIND operation reached
/// its successful terminal state after this exact PHOENIX recovery transition.
#[derive(Clone, Debug, Serialize, Deserialize, BorshSerialize, BorshDeserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub enum VerifiedSettlementOutcome {
    Succeeded,
}

#[derive(Clone, Debug, Serialize, Deserialize, BorshSerialize, BorshDeserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RecoveryReceiptBody {
    pub domain: Domain,
    pub task_id: String,
    pub primary_identity: String,
    pub backup_identity: String,
    pub checkpoint_hash: String,
    pub epoch_from: u64,
    pub epoch_to: u64,
    pub settlement_reference: String,
    pub settlement_outcome: VerifiedSettlementOutcome,
    /// Hash of the Sentinel's finalized REWIND operation evidence.
    pub settlement_evidence_hash: String,
    pub settlement_block_height: u64,
    pub security_revision: u64,
    pub nonce: u64,
    pub issued_at: u64,
    pub expires_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, BorshSerialize, BorshDeserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SignedRecoveryReceipt {
    pub body: RecoveryReceiptBody,
    pub signature: String,
}
impl Domain {
    pub fn validate(&self) -> Result<(), String> {
        if self.network != "sandbox" {
            return Err("Only sandbox approvals are supported".into());
        }
        for field in [
            &self.deployment,
            &self.core_id,
            &self.vault_id,
            &self.agent_id,
            &self.task_id,
            &self.execution_id,
        ] {
            if field.is_empty() || field.len() > 128 {
                return Err("Invalid approval domain".into());
            }
        }
        decode_hex::<32>(&self.code_digest)?;
        decode_hex::<32>(&self.policy_digest)?;
        Ok(())
    }
}
impl ApprovalBody {
    pub fn validate(&self, now: u64) -> Result<(), String> {
        self.domain.validate()?;
        decode_hex::<32>(&self.subject_key)?;
        decode_hex::<32>(&self.checkpoint_digest)?;
        decode_hex::<32>(&self.commitment)?;
        if self.requester.is_empty()
            || self.requester.len() > 64
            || self.recipient.is_empty()
            || self.recipient.len() > 64
            || self.operation_id.is_empty()
            || self.operation_id.len() > 64
        {
            return Err("Invalid approval intent".into());
        }
        let amount = self
            .amount
            .parse::<u128>()
            .map_err(|_| "Invalid approval amount")?;
        if amount.to_string() != self.amount
            || (self.action == Action::Payment && amount == 0)
            || (self.action != Action::Payment && amount != 0)
        {
            return Err("Invalid approval amount".into());
        }
        if self.nonce == 0
            || self.issued_at > now
            || now >= self.expires_at
            || self.expires_at - self.issued_at > MAX_APPROVAL_NS
        {
            return Err("Approval expired, future-dated or too old".into());
        }
        Ok(())
    }
    pub fn signing_bytes(&self) -> Vec<u8> {
        let mut bytes = b"NEAR_PHOENIX_SENTINEL_V1\0".to_vec();
        bytes.extend(borsh::to_vec(self).expect("Approval encoding"));
        bytes
    }
}

impl RecoveryReceiptBody {
    pub fn validate_structure(&self) -> Result<(), String> {
        self.domain.validate()?;
        if self.task_id != self.domain.task_id || self.task_id.is_empty() || self.task_id.len() > 64
        {
            return Err("Recovery receipt task mismatch".into());
        }
        decode_hex::<32>(&self.primary_identity)?;
        decode_hex::<32>(&self.backup_identity)?;
        decode_hex::<32>(&self.checkpoint_hash)?;
        decode_hex::<32>(&self.settlement_evidence_hash)?;
        if self.primary_identity == self.backup_identity {
            return Err("Recovery receipt identities must differ".into());
        }
        if self.epoch_from.checked_add(1) != Some(self.epoch_to) {
            return Err("Invalid recovery epoch transition".into());
        }
        if self.settlement_reference.is_empty()
            || self.settlement_reference.len() > 64
            || !self
                .settlement_reference
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        {
            return Err("Invalid settlement reference".into());
        }
        if self.settlement_block_height == 0 || self.nonce == 0 {
            return Err("Invalid recovery receipt evidence".into());
        }
        Ok(())
    }

    pub fn validate_at(&self, now: u64) -> Result<(), String> {
        self.validate_structure()?;
        if self.issued_at > now
            || now >= self.expires_at
            || self.expires_at - self.issued_at > MAX_APPROVAL_NS
        {
            return Err("Recovery receipt expired, future-dated or too old".into());
        }
        Ok(())
    }

    pub fn signing_bytes(&self) -> Vec<u8> {
        let mut bytes = b"NEAR_PHOENIX_RECOVERY_RECEIPT_V1\0".to_vec();
        bytes.extend(borsh::to_vec(self).expect("Recovery receipt encoding"));
        bytes
    }
}
impl ApprovalPolicy {
    pub fn validate(&self) -> Result<(), String> {
        self.domain.validate()?;
        decode_hex::<32>(&self.public_key)?;
        if self.requester.is_empty()
            || self.verifier.is_empty()
            || self.requester.len() > 64
            || self.verifier.len() > 64
            || self.requester == self.verifier
        {
            return Err("Self-issued or invalid account roles".into());
        }
        if self.worker_keys.is_empty() || self.worker_keys.len() > 9 || self.last_nonce != 0 {
            return Err("Invalid initial sentinel policy".into());
        }
        if self.allowed_actions.is_empty()
            || self.allowed_actions.len() > 4
            || self.allowed_recipients.is_empty()
            || self.allowed_recipients.len() > 32
        {
            return Err("Invalid action permissions".into());
        }
        for (i, action) in self.allowed_actions.iter().enumerate() {
            if self.allowed_actions[..i].contains(action) {
                return Err("Duplicate action permission".into());
            }
        }
        for target in &self.allowed_recipients {
            if target.is_empty() || target.len() > 64 {
                return Err("Invalid action recipient".into());
            }
        }
        let maximum = self
            .max_payment
            .parse::<u128>()
            .map_err(|_| "Invalid payment cap")?;
        if maximum.to_string() != self.max_payment {
            return Err("Invalid payment cap".into());
        }
        for (i, key) in self.worker_keys.iter().enumerate() {
            decode_hex::<32>(key)?;
            if key == &self.public_key || self.worker_keys[..i].contains(key) {
                return Err("Self-issued or duplicate sentinel key".into());
            }
        }
        Ok(())
    }
    pub fn check(&self, body: &ApprovalBody, now: u64) -> Result<(), String> {
        body.validate(now)?;
        if body.requester != self.requester {
            return Err("Wrong approval requester".into());
        }
        if self.domain != body.domain {
            return Err("Approval domain mismatch".into());
        }
        if self.public_key == body.subject_key || !self.worker_keys.contains(&body.subject_key) {
            return Err("Self-issued or unregistered subject".into());
        }
        if !self.allowed_actions.contains(&body.action)
            || !self.allowed_recipients.contains(&body.recipient)
        {
            return Err("Action or recipient not permitted".into());
        }
        let maximum = self
            .max_payment
            .parse::<u128>()
            .map_err(|_| "Invalid payment cap")?;
        if body.amount.parse::<u128>().map_err(|_| "Invalid amount")? > maximum {
            return Err("Approval budget exceeded".into());
        }
        if self.last_nonce.checked_add(1) != Some(body.nonce) {
            return Err("Approval replay or nonce mismatch".into());
        }
        Ok(())
    }
}
pub fn decode_hex<const N: usize>(value: &str) -> Result<[u8; N], String> {
    if value.len() != 2 * N
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Invalid canonical hex".into());
    }
    let mut bytes = [0; N];
    for (i, b) in bytes.iter_mut().enumerate() {
        *b = u8::from_str_radix(&value[2 * i..2 * i + 2], 16).map_err(|_| "Invalid hex")?;
    }
    Ok(bytes)
}
