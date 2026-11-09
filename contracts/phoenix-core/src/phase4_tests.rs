use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::{test_utils::VMContextBuilder, testing_env};
use phoenix_security_types::{RecoveryReceiptBody, VerifiedSettlementOutcome};
fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{b:02x}")).collect()
}
fn key(n: u8) -> String {
    hex(SigningKey::from_bytes(&[n; 32]).verifying_key().as_bytes())
}
fn ctx(caller: &str, time: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(id("core.testnet"))
        .predecessor_account_id(id(caller))
        .block_timestamp(time)
        .build());
}
fn policy() -> ApprovalPolicy {
    ApprovalPolicy {
        domain: phoenix_security_types::Domain {
            network: "sandbox".into(),
            deployment: "core-test-run".into(),
            core_id: "core.testnet".into(),
            vault_id: "vault.testnet".into(),
            agent_id: "agent.testnet".into(),
            task_id: "task".into(),
            execution_id: "execution".into(),
            code_digest: "aa".repeat(32),
            policy_digest: "bb".repeat(32),
        },
        public_key: key(9),
        requester: "coordinator.testnet".into(),
        verifier: "sentinel.testnet".into(),
        worker_keys: vec![key(1), key(2), key(3)],
        last_nonce: 0,
        allowed_actions: vec![Action::Recovery, Action::DataExport],
        allowed_recipients: vec![key(2), key(3), "service.testnet".into()],
        max_payment: "0".into(),
    }
}
fn setup() -> PhoenixCore {
    ctx("owner.testnet", 0);
    let mut c = PhoenixCore::new(id("owner.testnet"), id("guardian.testnet"));
    c.register_agent(
        id("agent.testnet"),
        id("coordinator.testnet"),
        id("sentinel.testnet"),
        U64(1_000_000_000),
    );
    c.configure_stateflow(
        id("agent.testnet"),
        "task".into(),
        key(1),
        vec![key(2), key(3)],
    );
    c.configure_sentinel(id("agent.testnet"), policy());
    ctx("coordinator.testnet", 1);
    c.commit_checkpoint(
        id("agent.testnet"),
        U64(0),
        U64(1),
        "ab".repeat(32),
        None,
        U64(10_000_000_000),
    );
    c
}
fn ticket(action: Action, nonce: u64, revision: u64) -> SignedApproval {
    let p = policy();
    let body = phoenix_security_types::ApprovalBody {
        domain: p.domain,
        action,
        requester: p.requester,
        subject_key: key(1),
        epoch: 0,
        security_revision: revision,
        checkpoint_digest: "ab".repeat(32),
        operation_id: if action == Action::Recovery {
            "ab".repeat(32)
        } else {
            "export-1".into()
        },
        recipient: if action == Action::Recovery {
            key(2)
        } else {
            "service.testnet".into()
        },
        amount: "0".into(),
        commitment: "ab".repeat(32),
        nonce,
        issued_at: 1,
        expires_at: 5_000_000_000,
    };
    sign(body, 9)
}
fn sign(body: phoenix_security_types::ApprovalBody, n: u8) -> SignedApproval {
    SignedApproval {
        signature: hex(&SigningKey::from_bytes(&[n; 32])
            .sign(&body.signing_bytes())
            .to_bytes()),
        body,
    }
}
fn proof_receipt(nonce: u64, epoch_from: u64, epoch_to: u64) -> SignedRecoveryReceipt {
    let p = policy();
    let body = RecoveryReceiptBody {
        domain: p.domain,
        task_id: "task".into(),
        primary_identity: key(1),
        backup_identity: key(2),
        checkpoint_hash: "ab".repeat(32),
        epoch_from,
        epoch_to,
        settlement_reference: "payment-1".into(),
        settlement_outcome: VerifiedSettlementOutcome::Succeeded,
        settlement_evidence_hash: "cd".repeat(32),
        settlement_block_height: 42,
        security_revision: 0,
        nonce,
        issued_at: 1_000_000_004,
        expires_at: 1_000_000_040,
    };
    SignedRecoveryReceipt {
        signature: hex(&SigningKey::from_bytes(&[9; 32])
            .sign(&body.signing_bytes())
            .to_bytes()),
        body,
    }
}
fn recovered() -> PhoenixCore {
    let mut c = setup();
    crash(&mut c);
    ctx("sentinel.testnet", 1_000_000_002);
    c.approve_signed_recovery(ticket(Action::Recovery, 1, 0));
    ctx("coordinator.testnet", 1_000_000_003);
    c.recover_checkpoint(id("agent.testnet"), U64(0), "ab".repeat(32), key(2));
    c
}
fn crash(c: &mut PhoenixCore) {
    ctx("watcher.testnet", 1_000_000_001);
    c.report_crash(id("agent.testnet"));
}
#[test]
fn independent_signed_recovery_consumed_under_fencing() {
    let mut c = setup();
    crash(&mut c);
    ctx("sentinel.testnet", 1_000_000_002);
    c.approve_signed_recovery(ticket(Action::Recovery, 1, 0));
    ctx("coordinator.testnet", 1_000_000_003);
    c.recover_checkpoint(id("agent.testnet"), U64(0), "ab".repeat(32), key(2));
    assert_eq!(c.get_agent(id("agent.testnet")).unwrap().generation.0, 1);
}
#[test]
fn recovery_receipt_binds_onchain_transition_and_is_publicly_verifiable() {
    let mut c = recovered();
    ctx("sentinel.testnet", 1_000_000_004);
    c.record_recovery_receipt(proof_receipt(2, 0, 1));
    let receipt = c.get_recovery_receipt(id("agent.testnet"), U64(1)).unwrap();
    assert_eq!(receipt.task_id, "task");
    assert_eq!(receipt.primary_identity, key(1));
    assert_eq!(receipt.backup_identity, key(2));
    assert_eq!(receipt.checkpoint_hash, "ab".repeat(32));
    assert_eq!(receipt.epoch_from, U64(0));
    assert_eq!(receipt.epoch_to, U64(1));
    assert_eq!(receipt.verified_by, Some(id("sentinel.testnet")));
    assert_eq!(
        receipt.signed_receipt.unwrap().body.settlement_reference,
        "payment-1"
    );
}
#[test]
#[should_panic(expected = "Forged recovery receipt")]
fn forged_recovery_receipt_is_rejected() {
    let mut c = recovered();
    let mut receipt = proof_receipt(2, 0, 1);
    receipt.signature = "00".repeat(64);
    ctx("sentinel.testnet", 1_000_000_004);
    c.record_recovery_receipt(receipt);
}
#[test]
#[should_panic(expected = "Receipt checkpoint mismatch")]
fn correctly_signed_receipt_with_mismatched_checkpoint_is_rejected() {
    let mut c = recovered();
    let mut receipt = proof_receipt(2, 0, 1);
    receipt.body.checkpoint_hash = "cd".repeat(32);
    receipt.signature = hex(&SigningKey::from_bytes(&[9; 32])
        .sign(&receipt.body.signing_bytes())
        .to_bytes());
    ctx("sentinel.testnet", 1_000_000_004);
    c.record_recovery_receipt(receipt);
}
#[test]
#[should_panic(expected = "Sentinel only")]
fn unauthorized_account_cannot_record_recovery_receipt() {
    let mut c = recovered();
    ctx("attacker.testnet", 1_000_000_004);
    c.record_recovery_receipt(proof_receipt(2, 0, 1));
}
#[test]
#[should_panic(expected = "Receipt already verified")]
fn recovery_receipt_replay_is_rejected() {
    let mut c = recovered();
    let receipt = proof_receipt(2, 0, 1);
    ctx("sentinel.testnet", 1_000_000_004);
    c.record_recovery_receipt(receipt.clone());
    c.record_recovery_receipt(receipt);
}
#[test]
#[should_panic(expected = "Recovery transition not found")]
fn stale_epoch_recovery_receipt_is_rejected() {
    let mut c = recovered();
    ctx("sentinel.testnet", 1_000_000_004);
    c.record_recovery_receipt(proof_receipt(2, 1, 2));
}
#[test]
#[should_panic(expected = "Already approved")]
fn conflicting_backup_recovery_approval_cannot_replace_pending_grant() {
    let mut c = setup();
    crash(&mut c);
    ctx("sentinel.testnet", 1_000_000_002);
    c.approve_signed_recovery(ticket(Action::Recovery, 1, 0));
    let mut conflicting = ticket(Action::Recovery, 2, 0).body;
    conflicting.recipient = key(3);
    c.approve_signed_recovery(sign(conflicting, 9));
}
#[test]
#[should_panic(expected = "Signed recovery approval required")]
fn unsigned_recovery_gate_cannot_bypass_sentinel() {
    let mut c = setup();
    crash(&mut c);
    ctx("sentinel.testnet", 1_000_000_002);
    c.approve_checkpoint_recovery(id("agent.testnet"), U64(0), "ab".repeat(32), key(2));
}
#[test]
#[should_panic(expected = "Forged sentinel approval")]
fn forged_worker_signed_recovery_rejected() {
    let mut c = setup();
    crash(&mut c);
    ctx("sentinel.testnet", 1_000_000_002);
    c.approve_signed_recovery(sign(ticket(Action::Recovery, 1, 0).body, 1));
}
#[test]
#[should_panic(expected = "Sentinel only")]
fn requester_cannot_issue_own_recovery() {
    let mut c = setup();
    crash(&mut c);
    ctx("coordinator.testnet", 1_000_000_002);
    c.approve_signed_recovery(ticket(Action::Recovery, 1, 0));
}
#[test]
#[should_panic(expected = "Recovery approval expired")]
fn signed_recovery_expires_before_checkpoint() {
    let mut c = setup();
    crash(&mut c);
    ctx("sentinel.testnet", 1_000_000_002);
    c.approve_signed_recovery(ticket(Action::Recovery, 1, 0));
    ctx("coordinator.testnet", 5_000_000_000);
    c.recover_checkpoint(id("agent.testnet"), U64(0), "ab".repeat(32), key(2));
}
#[test]
fn expired_recovery_lease_can_be_reissued_but_cannot_activate_backup() {
    let mut c = setup();
    crash(&mut c);
    ctx("sentinel.testnet", 1_000_000_002);
    c.approve_signed_recovery(ticket(Action::Recovery, 1, 0));
    ctx("anyone.testnet", 5_000_000_000);
    c.expire_recovery_lease(id("agent.testnet"));
    let agent = c.get_agent(id("agent.testnet")).unwrap();
    assert_eq!(agent.status, Status::Crashed);
    assert_eq!(agent.generation, U64(0));
    assert!(!agent.recovery_approved);
    assert!(c
        .get_stateflow(id("agent.testnet"))
        .unwrap()
        .grant
        .is_none());

    // Expiry only releases the lease. A fresh Sentinel ticket for a different
    // registered backup is still required before recovery can advance the epoch.
    let mut replacement = ticket(Action::Recovery, 2, 0).body;
    replacement.subject_key = key(1);
    replacement.recipient = key(3);
    replacement.issued_at = 5_000_000_000;
    replacement.expires_at = 9_000_000_000;
    ctx("sentinel.testnet", 5_000_000_001);
    c.approve_signed_recovery(sign(replacement, 9));
    let grant = c.get_stateflow(id("agent.testnet")).unwrap().grant.unwrap();
    assert_eq!(grant.backup_key, key(3));
    assert_eq!(c.get_agent(id("agent.testnet")).unwrap().generation, U64(0));
}
#[test]
#[should_panic(expected = "Recovery lease still active")]
fn active_recovery_lease_cannot_be_stolen() {
    let mut c = setup();
    crash(&mut c);
    ctx("sentinel.testnet", 1_000_000_002);
    c.approve_signed_recovery(ticket(Action::Recovery, 1, 0));
    ctx("anyone.testnet", 1_000_000_003);
    c.expire_recovery_lease(id("agent.testnet"));
}
#[test]
#[should_panic(expected = "Stale security revision")]
fn quarantine_invalidates_unused_recovery_ticket() {
    let mut c = setup();
    ctx("guardian.testnet", 2);
    c.contain(id("agent.testnet"));
    ctx("owner.testnet", 3);
    c.reopen_contained(id("agent.testnet"));
    ctx("sentinel.testnet", 4);
    c.approve_signed_recovery(ticket(Action::Recovery, 1, 0));
}
#[test]
fn quarantine_requires_owner_review_and_fresh_signed_recovery() {
    let mut c = setup();
    ctx("guardian.testnet", 2);
    c.contain(id("agent.testnet"));
    c.contain(id("agent.testnet"));
    assert_eq!(c.get_security_revision(id("agent.testnet")).0, 1);
    ctx("owner.testnet", 3);
    c.reopen_contained(id("agent.testnet"));
    ctx("sentinel.testnet", 4);
    c.approve_signed_recovery(ticket(Action::Recovery, 1, 1));
    ctx("coordinator.testnet", 5);
    c.recover_checkpoint(id("agent.testnet"), U64(0), "ab".repeat(32), key(2));
    assert_eq!(c.get_agent(id("agent.testnet")).unwrap().generation.0, 1);
}
#[test]
fn signed_high_risk_nonfinancial_action_consumes_nonce() {
    let mut c = setup();
    ctx("sentinel.testnet", 2);
    c.authorize_signed_action(ticket(Action::DataExport, 1, 0));
    assert_eq!(
        c.get_sentinel_policy(id("agent.testnet"))
            .unwrap()
            .last_nonce,
        1
    );
}
#[test]
#[should_panic(expected = "nonce mismatch")]
fn signed_high_risk_action_replay_rejected() {
    let mut c = setup();
    ctx("sentinel.testnet", 2);
    c.authorize_signed_action(ticket(Action::DataExport, 1, 0));
    c.authorize_signed_action(ticket(Action::DataExport, 1, 0));
}
#[test]
#[should_panic(expected = "Guardian or owner only")]
fn audit_anchors_require_security_authority() {
    let mut c = setup();
    ctx("coordinator.testnet", 2);
    c.anchor_security_audit(id("agent.testnet"), U64(1), "aa".repeat(32), None);
}
#[test]
#[should_panic(expected = "Audit predecessor mismatch")]
fn audit_fork_cannot_replace_anchored_history() {
    let mut c = setup();
    ctx("guardian.testnet", 2);
    c.anchor_security_audit(id("agent.testnet"), U64(1), "aa".repeat(32), None);
    c.anchor_security_audit(
        id("agent.testnet"),
        U64(2),
        "bb".repeat(32),
        Some("cc".repeat(32)),
    );
}
#[test]
#[should_panic(expected = "Audit sequence mismatch")]
fn audit_anchor_rollback_rejected() {
    let mut c = setup();
    ctx("guardian.testnet", 2);
    c.anchor_security_audit(id("agent.testnet"), U64(1), "aa".repeat(32), None);
    c.anchor_security_audit(id("agent.testnet"), U64(1), "bb".repeat(32), None);
}
