//! Local adversarial checks for the on-chain Phase 4 enforcement boundary.
use anyhow::Result;
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::{Account, Contract, Worker, network::Sandbox, types::NearToken};
use phoenix_recovery::guardian::{
    AuditHead, AuditLog, AuditRecord, Guardian, GuardianPolicy, SecurityChain, SecurityEvent,
    SecurityEventBody, SecurityEventKind, SecurityState,
};
use phoenix_recovery::sentinel::{Action, ApprovalBody, ApprovalPolicy, SignedApproval};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

const N: u128 = 1_000_000_000_000_000_000_000_000;
fn control_event(kind: &str, details: Value) {
    println!(
        "PHOENIX_CONTROL_EVENT {}",
        json!({"kind":kind,"details":details})
    );
}

struct SandboxSecurityChain {
    worker: Worker<Sandbox>,
    core: Contract,
    vault: Contract,
    guardian: Account,
    domain: phoenix_recovery::Domain,
}
impl SecurityChain for SandboxSecurityChain {
    fn domain(&self) -> &phoenix_recovery::Domain {
        &self.domain
    }
    async fn security_state(&self) -> Result<SecurityState> {
        let agent = crate::sandbox_adapter::view(
            &self.core,
            "get_agent",
            json!({"agent_id":self.domain.agent_id}),
        )
        .await?;
        let task = crate::sandbox_adapter::view(
            &self.vault,
            "get_task",
            json!({"task_id":self.domain.task_id}),
        )
        .await?;
        Ok(SecurityState {
            epoch: agent["generation"].as_str().unwrap().parse()?,
            running: agent["status"] == "Running",
            task_paused: task["paused"].as_bool().unwrap(),
            task_epoch: task["execution_epoch"].as_str().unwrap().parse()?,
        })
    }
    async fn now(&self) -> Result<u64> {
        Ok(self.worker.view_block().await?.timestamp())
    }
    async fn audit_head(&self) -> Result<Option<AuditHead>> {
        let value = crate::sandbox_adapter::view(
            &self.core,
            "get_security_audit",
            json!({"agent_id":self.domain.agent_id}),
        )
        .await?;
        if value.is_null() {
            return Ok(None);
        }
        Ok(Some(AuditHead {
            sequence: value["sequence"].as_str().unwrap().parse()?,
            digest: value["digest"].as_str().unwrap().to_owned(),
        }))
    }
    async fn anchor(&mut self, record: &AuditRecord) -> Result<()> {
        crate::sandbox_adapter::call(&self.worker, &self.guardian, &self.core, "anchor_security_audit", json!({"agent_id":self.domain.agent_id,"sequence":record.body.sequence.to_string(),"digest":record.digest()?,"previous_digest":record.body.previous_digest}), 0).await?;
        Ok(())
    }
    async fn quarantine(&mut self, _reason: &str) -> Result<()> {
        crate::sandbox_adapter::call(
            &self.worker,
            &self.guardian,
            &self.vault,
            "set_task_paused",
            json!({"task_id":self.domain.task_id,"paused":true}),
            0,
        )
        .await?;
        crate::sandbox_adapter::call(
            &self.worker,
            &self.guardian,
            &self.core,
            "contain",
            json!({"agent_id":self.domain.agent_id}),
            0,
        )
        .await?;
        Ok(())
    }
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn wasm(name: &str) -> Result<Vec<u8>> {
    Ok(std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(format!("../target/near/{name}/{name}.wasm")),
    )?)
}
async fn call(
    who: &Account,
    c: &near_workspaces::Contract,
    m: &str,
    a: Value,
    deposit: u128,
) -> Result<Value> {
    let result = who
        .call(c.id(), m)
        .args_json(a)
        .deposit(NearToken::from_yoctonear(deposit))
        .max_gas()
        .transact()
        .await?;
    let bytes = result.into_result()?.raw_bytes()?;
    if bytes.is_empty() {
        Ok(Value::Null)
    } else {
        Ok(serde_json::from_slice(&bytes)?)
    }
}
async fn rejected(
    who: &Account,
    c: &near_workspaces::Contract,
    m: &str,
    a: Value,
    reason: &str,
) -> Result<()> {
    let result = who
        .call(c.id(), m)
        .args_json(a)
        .max_gas()
        .transact()
        .await?;
    anyhow::ensure!(result.is_failure(), "{m} unexpectedly succeeded");
    anyhow::ensure!(
        format!("{result:?}").contains(reason),
        "Unexpected rejection: {result:?}"
    );
    Ok(())
}

pub async fn sentinel_guardian_sandbox() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let core = worker.dev_deploy(&wasm("phoenix_core")?).await?;
    let vault = worker.dev_deploy(&wasm("rewind_vault")?).await?;
    let owner = worker.dev_create_account().await?;
    let operator = worker.dev_create_account().await?;
    let sentinel = worker.dev_create_account().await?;
    let guardian = worker.dev_create_account().await?;
    let attacker = worker.dev_create_account().await?;
    let recipient = worker.dev_create_account().await?;
    call(
        &owner,
        &core,
        "new",
        json!({"owner":owner.id(),"guardian":guardian.id()}),
        0,
    )
    .await?;
    call(
        &owner,
        &vault,
        "new",
        json!({"owner":owner.id(),"guardian":guardian.id()}),
        0,
    )
    .await?;
    let sentinel_key = SigningKey::from_bytes(&[71; 32]);
    let worker_key = phoenix_recovery::worker_key(&SigningKey::from_bytes(&[72; 32]));
    let backup_key = phoenix_recovery::worker_key(&SigningKey::from_bytes(&[73; 32]));
    let deployment = format!(
        "phase4-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
    );
    let task_id = "phase4-task";
    let domain = phoenix_recovery::Domain {
        network: "sandbox".into(),
        deployment,
        core_id: core.id().to_string(),
        vault_id: vault.id().to_string(),
        agent_id: operator.id().to_string(),
        task_id: task_id.into(),
        execution_id: "phase4-execution".into(),
        code_digest: "11".repeat(32),
        policy_digest: "22".repeat(32),
    };
    let policy = ApprovalPolicy {
        domain: domain.clone(),
        public_key: hex(&sentinel_key.verifying_key().to_bytes()),
        requester: operator.id().to_string(),
        verifier: sentinel.id().to_string(),
        worker_keys: vec![worker_key.clone(), backup_key.clone()],
        last_nonce: 0,
        allowed_actions: vec![Action::Payment, Action::DataExport],
        allowed_recipients: vec![recipient.id().to_string(), "export.test".into()],
        max_payment: N.to_string(),
    };
    let plan = phoenix_recovery::Plan {
        domain: domain.clone(),
        worker_keys: vec![worker_key.clone(), backup_key.clone()],
        effects: vec![phoenix_recovery::Effect {
            name: "invoice".into(),
            recipient: recipient.id().to_string(),
            amount: N.to_string(),
        }],
    };
    call(&owner, &core, "register_agent", json!({"agent_id":domain.agent_id,"operator":operator.id(),"sentinel":sentinel.id(),"timeout_ns":"300000000000"}), 0).await?;
    call(&owner, &core, "configure_stateflow", json!({"agent_id":domain.agent_id,"task_id":task_id,"worker_key":worker_key,"backup_keys":[backup_key]}), 0).await?;
    call(
        &owner,
        &core,
        "configure_sentinel",
        json!({"agent_id":domain.agent_id,"policy":policy}),
        0,
    )
    .await?;
    let now = worker.view_block().await?.timestamp();
    call(&owner, &vault, "create_task", json!({"task_id":task_id,"executor":operator.id(),"verifier":sentinel.id(),"recipients":[{"account_id":recipient.id(),"limit":N.to_string()}],"escrow_amount":(2*N).to_string(),"expires_at":(now+86_400_000_000_000u64).to_string()}), 2*N + N/40).await?;
    call(
        &owner,
        &vault,
        "enable_task_fencing",
        json!({"task_id":task_id}),
        0,
    )
    .await?;
    call(
        &owner,
        &vault,
        "configure_sentinel",
        json!({"task_id":task_id,"policy":policy}),
        N / 25,
    )
    .await?;
    let operation = "phase4-payment-unique";
    call(&operator, &vault, "reserve_fenced_payment", json!({"task_id":task_id,"operation_id":operation,"recipient":recipient.id(),"amount":N.to_string(),"commitment":"ab".repeat(32),"epoch":"0"}), N/100).await?;

    // A forged ticket and an attacker NEAR predecessor are independently rejected.
    let body = ApprovalBody {
        domain: domain.clone(),
        action: Action::Payment,
        requester: operator.id().to_string(),
        subject_key: worker_key,
        epoch: 0,
        security_revision: 0,
        checkpoint_digest: "cd".repeat(32),
        operation_id: operation.into(),
        recipient: recipient.id().to_string(),
        amount: N.to_string(),
        commitment: "ab".repeat(32),
        nonce: 1,
        issued_at: worker.view_block().await?.timestamp(),
        expires_at: worker.view_block().await?.timestamp() + 30_000_000_000,
    };
    let ticket = SignedApproval {
        signature: hex(&sentinel_key.sign(&body.signing_bytes()).to_bytes()),
        body: body.clone(),
    };
    // A correctly signed but expired, task-bound ticket must still fail on chain.
    // Rejection must not consume the approval nonce, so the fresh ticket below remains usable.
    let mut expired_body = body.clone();
    expired_body.issued_at = 0;
    expired_body.expires_at = 1;
    let expired_ticket = SignedApproval {
        signature: hex(&sentinel_key.sign(&expired_body.signing_bytes()).to_bytes()),
        body: expired_body,
    };
    rejected(
        &sentinel,
        &vault,
        "approve_signed_payment",
        json!({"approval":expired_ticket}),
        "Invalid signed approval",
    )
    .await?;
    let mut forged = ticket.clone();
    forged.signature = hex(&[0; 64]);
    rejected(
        &sentinel,
        &vault,
        "approve_signed_payment",
        json!({"approval":forged}),
        "Forged sentinel approval",
    )
    .await?;
    rejected(
        &attacker,
        &vault,
        "approve_signed_payment",
        json!({"approval":ticket.clone()}),
        "Verifier only",
    )
    .await?;
    control_event(
        "suspicious_approval_rejected",
        json!({"operation_id":operation,"reason":"forged SENTINEL signature rejected on-chain"}),
    );
    call(
        &sentinel,
        &vault,
        "approve_signed_payment",
        json!({"approval":ticket}),
        0,
    )
    .await?;
    let recipient_before = recipient.view_account().await?.balance.as_yoctonear();
    rejected(
        &attacker,
        &vault,
        "settle_fenced_payment",
        json!({"operation_id":operation,"epoch":"0"}),
        "Executor only",
    )
    .await?;
    control_event(
        "suspicious_payment_rejected",
        json!({"operation_id":operation,"reason":"unauthorized settlement signer rejected on-chain"}),
    );
    call(
        &operator,
        &vault,
        "settle_fenced_payment",
        json!({"operation_id":operation,"epoch":"0"}),
        0,
    )
    .await?;
    let recipient_after = recipient.view_account().await?.balance.as_yoctonear();
    anyhow::ensure!(
        recipient_after - recipient_before == N,
        "Settlement did not transfer exact amount"
    );
    control_event(
        "payment_settled",
        json!({"operation_id":operation,"amount":N.to_string(),"recipient_delta":(recipient_after-recipient_before).to_string()}),
    );
    // Payment ID remains one-shot even if the executor attempts another settlement.
    rejected(
        &operator,
        &vault,
        "settle_fenced_payment",
        json!({"operation_id":operation,"epoch":"0"}),
        "Operation not reserved",
    )
    .await?;
    control_event(
        "duplicate_payment_prevented",
        json!({"operation_id":operation,"state":"permanent operation tombstone"}),
    );
    // GUARDIAN consumes an independent signed event after the rejected attacker call.
    // Its chain adapter applies both scoped stops, then anchors the signed audit record.
    rejected(
        &attacker,
        &vault,
        "set_task_paused",
        json!({"task_id":task_id,"paused":false}),
        "Owner only",
    )
    .await?;
    rejected(&attacker, &core, "anchor_security_audit", json!({"agent_id":domain.agent_id,"sequence":"1","digest":"ef".repeat(32),"previous_digest":null}), "Guardian or owner only").await?;
    let observer_key = SigningKey::from_bytes(&[74; 32]);
    let audit_key = SigningKey::from_bytes(&[75; 32]);
    let temp_dir = std::env::temp_dir().join(format!("phoenix-phase4-{}", domain.deployment));
    let log = AuditLog::open(&temp_dir, &domain, audit_key)?;
    let guardian_policy = GuardianPolicy {
        observer_keys: vec![phoenix_recovery::worker_key(&observer_key)],
        failures_threshold: 1,
        max_payments_per_window: 8,
        window_ns: 60_000_000_000,
        max_events_per_window: 20,
        max_worker_actions: 10,
        risk_quarantine_threshold: 90,
        max_event_age_ns: 60_000_000_000,
    };
    let mut monitor = Guardian::new(plan, guardian_policy, log)?;
    let mut chain = SandboxSecurityChain {
        worker: worker.clone(),
        core: core.clone(),
        vault: vault.clone(),
        guardian: guardian.clone(),
        domain: domain.clone(),
    };
    let event_time = chain.now().await?;
    let event = SecurityEvent::sign(
        SecurityEventBody {
            domain: domain.clone(),
            source_key: phoenix_recovery::worker_key(&observer_key),
            source_nonce: 1,
            evidence_id: phoenix_recovery::digest(
                b"phase4 sandbox observed rejected unauthorized payment",
            ),
            epoch: 0,
            issued_at: event_time,
            kind: SecurityEventKind::AuthorizationFailure,
        },
        &observer_key,
    )?;
    let decision = monitor.handle(&mut chain, event).await?;
    anyhow::ensure!(
        matches!(
            decision,
            phoenix_recovery::guardian::Decision::Quarantine { .. }
        ),
        "Expected GUARDIAN quarantine"
    );
    control_event(
        "guardian_quarantined",
        json!({"task":task_id,"audit_sequence":1,"decision":format!("{decision:?}")}),
    );
    anyhow::ensure!(
        chain.security_state().await?.task_paused,
        "Task was not quarantined"
    );
    anyhow::ensure!(
        !chain.security_state().await?.running,
        "Agent was not contained"
    );
    anyhow::ensure!(
        chain
            .audit_head()
            .await?
            .is_some_and(|head| head.sequence == 1),
        "Audit not anchored"
    );
    // A quarantined task cannot be reopened by the executor or an unrelated caller.
    rejected(
        &operator,
        &vault,
        "set_task_paused",
        json!({"task_id":task_id,"paused":false}),
        "Owner only",
    )
    .await?;
    rejected(
        &attacker,
        &core,
        "reopen_contained",
        json!({"agent_id":domain.agent_id}),
        "Owner only",
    )
    .await?;
    anyhow::ensure!(
        chain.security_state().await?.task_paused,
        "Unauthorized quarantine bypass changed task state"
    );
    Ok(())
}
