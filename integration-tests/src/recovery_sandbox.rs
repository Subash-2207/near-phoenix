use crate::sandbox_adapter::*;
use anyhow::{Context, Result, ensure};
use ed25519_dalek::SigningKey;
use near_jsonrpc_client::{JsonRpcClient, methods};
use near_primitives::types::Finality;
use near_workspaces::{Worker, network::Sandbox};
use phoenix_recovery::guardian::{
    AuditHead, AuditLog, AuditRecord, Decision, Guardian, GuardianPolicy, SecurityChain,
    SecurityEvent, SecurityEventBody, SecurityEventKind, SecurityState,
};
use phoenix_recovery::sentinel::{
    Action, ApprovalPolicy, FinalizedSettlementEvidence, RecoveryReceiptReview, Sentinel,
    verify_recovery_receipt_evidence,
};
use phoenix_recovery::*;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

struct WorkerProcess {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl WorkerProcess {
    fn start(plan: &Plan, seed: u8, epoch: u64) -> Result<Self> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../services/recovery/target/debug/phoenix-worker");
        let mut child=Command::new(&path).env_clear()
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().with_context(||format!("Build worker first: cargo build --manifest-path services/recovery/Cargo.toml --bin phoenix-worker ({})",path.display()))?;
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let mut worker = Self {
            child,
            input,
            output,
        };
        // Deterministic test-only worker keys. These are never NEAR transaction keys.
        worker
            .request(json!({"action":"init","seed":hex(&[seed;32]),"plan":plan,"epoch":epoch}))?;
        Ok(worker)
    }
    fn request(&mut self, value: Value) -> Result<Value> {
        serde_json::to_writer(&mut self.input, &value)?;
        writeln!(&mut self.input)?;
        self.input.flush()?;
        let mut line = String::new();
        ensure!(self.output.read_line(&mut line)? > 0, "Worker exited");
        let result: Value = serde_json::from_str(&line)?;
        ensure!(
            result.get("error").is_none(),
            "Worker rejected action: {}",
            result["error"]
        );
        Ok(result["ok"].clone())
    }
    fn crash(&mut self) -> Result<()> {
        self.child.kill()?;
        let status = self.child.wait()?;
        ensure!(!status.success(), "Primary did not crash");
        Ok(())
    }
}
impl Drop for WorkerProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
struct BackupHost {
    backups: Vec<(String, WorkerProcess)>,
    observer: Observer,
    restored: Option<Restoration>,
    stop: tokio::sync::watch::Sender<bool>,
}
impl WorkerHost for BackupHost {
    async fn ready(&mut self) -> Result<Vec<Heartbeat>> {
        let now = self.observer.snapshot().await?.now;
        let mut pulses = Vec::new();
        // Reverse arrival order; configured on-chain order remains authoritative.
        for (_, backup) in self.backups.iter_mut().rev() {
            if let Ok(value) =
                backup.request(json!({"action":"pulse","sequence":1,"issued_at":now}))
            {
                pulses.push(serde_json::from_value(value)?);
            }
        }
        Ok(pulses)
    }
    async fn restore(&mut self, restoration: Restoration) -> Result<()> {
        let now = self.observer.snapshot().await?.now;
        let (_, backup) = self
            .backups
            .iter_mut()
            .find(|(key, _)| key == &restoration.session.worker_key)
            .context("Selected backup process is unavailable")?;
        let state:TaskState=serde_json::from_value(backup.request(json!({"action":"restore","epoch":restoration.session.epoch,"checkpoint":restoration.checkpoint,"now":now}))?)?;
        ensure!(
            state == restoration.checkpoint.body.state,
            "Backup state mismatch"
        );
        // A repeated host delivery must not rewind a running worker.
        backup.request(json!({"action":"step","result":"backup resumed computation","requested_effects":["invoice"]}))?;
        let repeated:TaskState=serde_json::from_value(backup.request(json!({"action":"restore","epoch":restoration.session.epoch,"checkpoint":restoration.checkpoint,"now":now}))?)?;
        ensure!(
            repeated.completed_steps == state.completed_steps + 1,
            "Repeated restore rewound worker"
        );
        eprintln!(
            "BACKUP RESTORED epoch={} completed_steps={}",
            restoration.session.epoch, state.completed_steps
        );
        self.restored = Some(restoration);
        self.stop.send(true)?;
        Ok(())
    }
}
struct Temp(PathBuf);
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn number(value: &Value) -> Result<u64> {
    Ok(value
        .as_str()
        .context("Expected chain U64 string")?
        .parse()?)
}

struct SandboxSecurityChain {
    observer: Observer,
    guardian: near_workspaces::Account,
    domain: Domain,
}

impl SecurityChain for SandboxSecurityChain {
    fn domain(&self) -> &Domain {
        &self.domain
    }

    async fn security_state(&self) -> Result<SecurityState> {
        let agent = view(
            &self.observer.core,
            "get_agent",
            json!({"agent_id":self.domain.agent_id}),
        )
        .await?;
        let task = self.observer.task().await?;
        Ok(SecurityState {
            epoch: number(&agent["generation"])?,
            running: agent["status"] == "Running",
            task_paused: task["paused"]
                .as_bool()
                .context("Missing task paused state")?,
            task_epoch: number(&task["execution_epoch"])?,
        })
    }

    async fn now(&self) -> Result<u64> {
        Ok(self.observer.worker.view_block().await?.timestamp())
    }

    async fn audit_head(&self) -> Result<Option<AuditHead>> {
        let value = view(
            &self.observer.core,
            "get_security_audit",
            json!({"agent_id":self.domain.agent_id}),
        )
        .await?;
        if value.is_null() {
            return Ok(None);
        }
        Ok(Some(AuditHead {
            sequence: number(&value["sequence"])?,
            digest: value["digest"]
                .as_str()
                .context("Missing audit digest")?
                .to_owned(),
        }))
    }

    async fn anchor(&mut self, record: &AuditRecord) -> Result<()> {
        call(
            &self.observer.worker,
            &self.guardian,
            &self.observer.core,
            "anchor_security_audit",
            json!({
                "agent_id":self.domain.agent_id,
                "sequence":record.body.sequence.to_string(),
                "digest":record.digest()?,
                "previous_digest":record.body.previous_digest,
            }),
            0,
        )
        .await?;
        Ok(())
    }

    async fn quarantine(&mut self, _reason: &str) -> Result<()> {
        call(
            &self.observer.worker,
            &self.guardian,
            &self.observer.vault,
            "set_task_paused",
            json!({"task_id":self.domain.task_id,"paused":true}),
            0,
        )
        .await?;
        call(
            &self.observer.worker,
            &self.guardian,
            &self.observer.core,
            "contain",
            json!({"agent_id":self.domain.agent_id}),
            0,
        )
        .await?;
        Ok(())
    }
}

fn wasm(name: &str) -> Result<Vec<u8>> {
    Ok(std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(format!("../target/near/{name}/{name}.wasm")),
    )?)
}
fn control_event(kind: &str, details: Value) {
    println!(
        "PHOENIX_CONTROL_EVENT {}",
        json!({"kind":kind,"details":details})
    );
}

async fn finalized_block(worker: &Worker<Sandbox>) -> Result<(u64, String)> {
    let response = JsonRpcClient::connect(worker.rpc_addr())
        .call(methods::block::RpcBlockRequest {
            block_reference: Finality::Final.into(),
        })
        .await?;
    Ok((response.header.height, response.header.hash.to_string()))
}

pub async fn run_demo() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let core_bytes = wasm("phoenix_core")?;
    let vault_bytes = wasm("rewind_vault")?;
    let core = worker.dev_deploy(&core_bytes).await?;
    let vault = worker.dev_deploy(&vault_bytes).await?;
    let owner = worker.dev_create_account().await?;
    let operator = worker.dev_create_account().await?;
    let sentinel = worker.dev_create_account().await?;
    let guardian = worker.dev_create_account().await?;
    let watcher = worker.dev_create_account().await?;
    let attacker = worker.dev_create_account().await?;
    let recipient = worker.dev_create_account().await?;
    call(
        &worker,
        &owner,
        &core,
        "new",
        json!({"owner":owner.id(),"guardian":guardian.id()}),
        0,
    )
    .await?;
    call(
        &worker,
        &owner,
        &vault,
        "new",
        json!({"owner":owner.id(),"guardian":guardian.id()}),
        0,
    )
    .await?;
    let primary_key = worker_key(&SigningKey::from_bytes(&[11; 32]));
    let backup_key = worker_key(&SigningKey::from_bytes(&[22; 32]));
    let secondary_backup_key = worker_key(&SigningKey::from_bytes(&[33; 32]));
    let sentinel_key = SigningKey::from_bytes(&[42; 32]);
    let domain = Domain {
        network: "sandbox".into(),
        deployment: format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
        ),
        core_id: core.id().to_string(),
        vault_id: vault.id().to_string(),
        agent_id: operator.id().to_string(),
        task_id: "recovery-task".into(),
        execution_id: "primary-execution".into(),
        code_digest: digest(&[core_bytes, vault_bytes].concat()),
        policy_digest: digest(b"sandbox-phase3-policy-v1"),
    };
    let plan = Plan {
        domain: domain.clone(),
        worker_keys: vec![
            primary_key.clone(),
            backup_key.clone(),
            secondary_backup_key.clone(),
        ],
        effects: vec![Effect {
            name: "invoice".into(),
            recipient: recipient.id().to_string(),
            amount: "1000000000000000000000000".into(),
        }],
    };
    let sentinel_policy = ApprovalPolicy {
        domain: domain.clone(),
        public_key: worker_key(&sentinel_key),
        requester: operator.id().to_string(),
        verifier: sentinel.id().to_string(),
        worker_keys: plan.worker_keys.clone(),
        last_nonce: 0,
        allowed_actions: vec![Action::Recovery, Action::Payment],
        allowed_recipients: vec![
            backup_key.clone(),
            secondary_backup_key.clone(),
            recipient.id().to_string(),
        ],
        max_payment: plan.effects[0].amount.clone(),
    };
    call(&worker,&owner,&core,"register_agent",json!({"agent_id":domain.agent_id,"operator":operator.id(),"sentinel":sentinel.id(),"timeout_ns":"300000000000"}),0).await?;
    call(&worker,&owner,&core,"configure_stateflow",json!({"agent_id":domain.agent_id,"task_id":domain.task_id,"worker_key":primary_key,"backup_keys":[backup_key,secondary_backup_key]}),0).await?;
    call(
        &worker,
        &owner,
        &core,
        "configure_sentinel",
        json!({"agent_id":domain.agent_id,"policy":sentinel_policy}),
        0,
    )
    .await?;
    let now = worker.view_block().await?.timestamp();
    call(&worker,&owner,&vault,"create_task",json!({"task_id":domain.task_id,"executor":operator.id(),"verifier":sentinel.id(),"recipients":[{"account_id":recipient.id(),"limit":"2000000000000000000000000"}],"escrow_amount":"3000000000000000000000000","expires_at":(now+86_400_000_000_000u64).to_string()}),3_025_000_000_000_000_000_000_000).await?;
    call(
        &worker,
        &owner,
        &vault,
        "enable_task_fencing",
        json!({"task_id":domain.task_id}),
        0,
    )
    .await?;
    control_event(
        "sandbox_configured",
        json!({
            "network":"sandbox",
            "deployment":domain.deployment,
            "core_id":core.id().to_string(),
            "vault_id":vault.id().to_string(),
            "agent_id":domain.agent_id,
            "task_id":domain.task_id,
            "sentinel_account":sentinel.id().to_string(),
            "sentinel_public_key":sentinel_policy.public_key,
        }),
    );
    call(
        &worker,
        &owner,
        &vault,
        "configure_sentinel",
        json!({"task_id":domain.task_id,"policy":sentinel_policy}),
        40_000_000_000_000_000_000_000,
    )
    .await?;
    let observer = Observer {
        worker: worker.clone(),
        core: core.clone(),
        vault: vault.clone(),
        domain: domain.clone(),
        operator_id: operator.id().to_string(),
        sentinel_id: sentinel.id().to_string(),
    };
    let mut chain = SandboxChain {
        observer: observer.clone(),
        operator: operator.clone(),
        watcher: watcher.clone(),
    };
    let mut verifier = SandboxVerifier {
        observer: observer.clone(),
        signer: sentinel.clone(),
        plan: plan.clone(),
        policy: sentinel_policy.clone(),
        sentinel_key: sentinel_key.clone(),
    };
    let temp = Temp(std::env::temp_dir().join(format!("phoenix-e2e-{}", domain.deployment)));
    let mut coordinator = Coordinator::new(plan.clone(), CheckpointStore::open(&temp.0)?)?;
    let mut primary = WorkerProcess::start(&plan, 11, 0)?;
    primary.request(json!({"action":"start"}))?;
    primary.request(json!({"action":"step","result":"primary computed invoice","requested_effects":["invoice"]}))?;
    let now = observer.snapshot().await?.now;
    let checkpoint:SignedCheckpoint=serde_json::from_value(primary.request(json!({"action":"checkpoint","sequence":1,"previous_digest":null,"issued_at":now,"expires_at":now+86_000_000_000_000u64}))?)?;
    let primary_session = coordinator.save(&mut chain, &checkpoint).await?;
    control_event(
        "primary_heartbeat",
        json!({"epoch":primary_session.epoch,"worker":primary_session.worker_key}),
    );
    control_event(
        "checkpoint_committed",
        json!({"sequence":checkpoint.body.sequence,"digest":checkpoint.digest()?}),
    );
    eprintln!(
        "PRIMARY CHECKPOINT COMMITTED digest={}",
        checkpoint.digest()?
    );
    let id = plan.payment_id(&plan.effects[0])?;
    // Fail the primary before payment so the restored backup executes the
    // checkpointed effect under the new fenced epoch.
    primary.crash()?;
    control_event(
        "primary_failed",
        json!({"epoch":primary_session.epoch,"checkpoint":checkpoint.digest()?}),
    );
    eprintln!("PRIMARY PROCESS KILLED before settlement");
    worker.fast_forward(2000).await?;
    // Detect/report failure first, then reject a tampered checkpoint independently.
    assert!(matches!(
        coordinator.tick(&mut chain, &mut verifier, &[]).await?,
        Tick::NoBackup
    ));
    rejected(
        &worker,
        &attacker,
        &core,
        "recover_checkpoint",
        json!({"agent_id":domain.agent_id,"generation":"0","digest":checkpoint.digest()? ,"backup_key":backup_key}),
        0,
        "Operator only",
    )
    .await?;
    rejected(
        &worker,
        &operator,
        &core,
        "recover_checkpoint",
        json!({"agent_id":domain.agent_id,"generation":"0","digest":checkpoint.digest()? ,"backup_key":backup_key}),
        0,
        "Independent approval required",
    )
    .await?;
    let mut tampered = checkpoint.clone();
    tampered.body.state.result = "tampered".into();
    assert!(
        verifier
            .authorize_recovery(&tampered, &backup_key)
            .await
            .is_err()
    );
    assert_eq!(
        view(&vault, "get_task", json!({"task_id":domain.task_id})).await?["execution_epoch"],
        "0"
    );
    // Automatic detection above reported the expired primary. Now the polling
    // monitor selects a ready backup and consumes the independently bound grant.
    let (stop, receive) = tokio::sync::watch::channel(false);
    let mut host = BackupHost {
        backups: vec![
            (
                plan.worker_keys[1].clone(),
                WorkerProcess::start(&plan, 22, 1)?,
            ),
            (
                plan.worker_keys[2].clone(),
                WorkerProcess::start(&plan, 33, 1)?,
            ),
        ],
        observer: observer.clone(),
        restored: None,
        stop,
    };
    // Simulate the preferred secondary failing to start; its absence from fresh
    // signed pulses lets the mesh fail over to the next configured backup.
    host.backups[0].1.crash()?;
    tokio::time::timeout(
        Duration::from_secs(60),
        monitor(
            &mut coordinator,
            &mut chain,
            &mut verifier,
            &mut host,
            Duration::from_millis(20),
            receive,
        ),
    )
    .await??;
    let restoration = host
        .restored
        .take()
        .context("Monitor did not restore backup")?;
    assert_eq!(restoration.session.epoch, 1);
    assert_eq!(observer.snapshot().await?.worker_key, secondary_backup_key);
    // A second candidate cannot consume the old recovery grant or race the
    // already committed epoch transition, even when it was registry-authorized.
    rejected(
        &worker,
        &operator,
        &core,
        "recover_checkpoint",
        json!({"agent_id":domain.agent_id,"generation":"0","digest":checkpoint.digest()? ,"backup_key":backup_key}),
        0,
        "Stale generation",
    )
    .await?;
    control_event(
        "backup_restored",
        json!({"epoch":restoration.session.epoch,"worker":restoration.session.worker_key,"checkpoint":restoration.checkpoint.digest()?}),
    );
    // Old coordinator/session and worker epochs cannot authorize more spending.
    assert!(
        coordinator
            .execute_payments(&mut chain, &mut verifier, &primary_session, &checkpoint)
            .await
            .is_err()
    );
    rejected(
        &worker,
        &operator,
        &core,
        "heartbeat",
        json!({"agent_id":domain.agent_id,"generation":"0"}),
        0,
        "Stale generation",
    )
    .await?;
    // Backup continues the restored task and anchors the next signed epoch.
    let now = observer.snapshot().await?.now;
    let selected_backup = host
        .backups
        .iter_mut()
        .find(|(key, _)| key == &secondary_backup_key)
        .context("Selected backup worker missing")?;
    let backup_checkpoint:SignedCheckpoint=serde_json::from_value(selected_backup.1.request(json!({"action":"checkpoint","sequence":2,"previous_digest":checkpoint.digest()?,"issued_at":now,"expires_at":now+86_000_000_000_000u64}))?)?;
    let backup_session = coordinator.save(&mut chain, &backup_checkpoint).await?;
    assert_eq!(backup_checkpoint.body.state.completed_steps, 2);
    let before = recipient.view_account().await?.balance.as_yoctonear();
    assert_eq!(
        coordinator
            .execute_payments(
                &mut chain,
                &mut verifier,
                &backup_session,
                &backup_checkpoint
            )
            .await?,
        vec![PaymentOutcome::Paid]
    );
    control_event(
        "payment_settled",
        json!({"operation_id":id,"outcome":"Paid","epoch":backup_session.epoch,"recipient":plan.effects[0].recipient,"amount":plan.effects[0].amount}),
    );
    assert_eq!(
        recipient.view_account().await?.balance.as_yoctonear(),
        before + 1_000_000_000_000_000_000_000_000u128
    );
    rejected(
        &worker,
        &operator,
        &vault,
        "settle_fenced_payment",
        json!({"operation_id":id,"epoch":"0"}),
        0,
        "Stale task epoch",
    )
    .await?;
    rejected(
        &worker,
        &watcher,
        &vault,
        "settle_fenced_payment",
        json!({"operation_id":id,"epoch":"1"}),
        0,
        "Executor only",
    )
    .await?;
    rejected(
        &worker,
        &operator,
        &vault,
        "settle_fenced_payment",
        json!({"operation_id":id,"epoch":"1"}),
        0,
        "Operation not reserved",
    )
    .await?;
    rejected(&worker, &operator, &vault, "reserve_fenced_payment", json!({"task_id":domain.task_id,"operation_id":id,"recipient":recipient.id(),"amount":plan.effects[0].amount,"commitment":id,"epoch":"1"}), 10_000_000_000_000_000_000_000, "Operation ID already used").await?;
    let task = view(&vault, "get_task", json!({"task_id":domain.task_id})).await?;
    assert_eq!(task["paid"], "1000000000000000000000000");
    assert_eq!(task["execution_epoch"], "1");
    control_event(
        "duplicate_payment_prevented",
        json!({"operation_id":id,"paid":task["paid"],"recipient_balance_delta":"1000000000000000000000000"}),
    );
    let settlement = observer
        .payment(&id)
        .await?
        .context("Finalized REWIND settlement is missing")?;
    ensure!(
        settlement.state == PaymentState::Succeeded
            && settlement.task_id == domain.task_id
            && settlement.recipient == plan.effects[0].recipient
            && settlement.amount == plan.effects[0].amount
            && settlement.commitment == id
            && settlement.epoch == Some(1)
            && !settlement.approved,
        "Finalized REWIND operation did not match the authorized effect"
    );
    let (settlement_block_height, settlement_block_hash) = finalized_block(&worker).await?;
    let evidence = FinalizedSettlementEvidence {
        task_id: settlement.task_id.clone(),
        settlement_reference: id.clone(),
        outcome: PaymentState::Succeeded,
        recipient: settlement.recipient.clone(),
        amount: settlement.amount.clone(),
        execution_epoch: settlement.epoch,
        block_height: settlement_block_height,
        block_hash: settlement_block_hash,
    };
    let active = observer.snapshot().await?;
    let mut receipt_policy = sentinel_policy.clone();
    receipt_policy.last_nonce = 1;
    let sentinel_service =
        Sentinel::new(plan.clone(), receipt_policy.clone(), sentinel_key.clone())?;
    let signed_receipt = sentinel_service.recovery_receipt(RecoveryReceiptReview {
        checkpoint: &checkpoint,
        active: &active,
        settlement: &settlement,
        evidence: &evidence,
        security_revision: 0,
    })?;
    verify_recovery_receipt_evidence(&signed_receipt, &evidence, &receipt_policy)?;
    call(
        &worker,
        &sentinel,
        &core,
        "record_recovery_receipt",
        json!({"receipt":signed_receipt.clone()}),
        0,
    )
    .await?;
    let on_chain_proof = view(
        &core,
        "get_recovery_receipt",
        json!({"agent_id":domain.agent_id,"epoch_to":"1"}),
    )
    .await?;
    ensure!(
        on_chain_proof["verified_by"] == sentinel.id().as_str()
            && on_chain_proof["signed_receipt"]["signature"] == signed_receipt.signature
            && on_chain_proof["checkpoint_hash"] == checkpoint.digest()?
            && on_chain_proof["epoch_from"] == "0"
            && on_chain_proof["epoch_to"] == "1",
        "Core did not store the verified receipt for this recovery transition"
    );
    let body = &signed_receipt.body;
    control_event(
        "recovery_receipt_verified",
        json!({
            "body":{
                "domain":{
                    "network":body.domain.network,
                    "deployment":body.domain.deployment,
                    "core_id":body.domain.core_id,
                    "vault_id":body.domain.vault_id,
                    "agent_id":body.domain.agent_id,
                    "task_id":body.domain.task_id,
                    "execution_id":body.domain.execution_id,
                    "code_digest":body.domain.code_digest,
                    "policy_digest":body.domain.policy_digest,
                },
                "task_id":body.task_id,
                "primary_identity":body.primary_identity,
                "backup_identity":body.backup_identity,
                "checkpoint_hash":body.checkpoint_hash,
                "epoch_from":body.epoch_from.to_string(),
                "epoch_to":body.epoch_to.to_string(),
                "settlement_reference":body.settlement_reference,
                "settlement_outcome":"Succeeded",
                "settlement_evidence_hash":body.settlement_evidence_hash,
                "settlement_block_height":body.settlement_block_height.to_string(),
                "security_revision":body.security_revision.to_string(),
                "nonce":body.nonce.to_string(),
                "issued_at":body.issued_at.to_string(),
                "expires_at":body.expires_at.to_string(),
            },
            "signature":signed_receipt.signature,
            "signing_bytes_hex":hex(&body.signing_bytes()),
            "evidence":evidence,
            "verified_by":on_chain_proof["verified_by"],
            "core_id":core.id().to_string(),
            "vault_id":vault.id().to_string(),
            "on_chain_verified":true,
        }),
    );

    let guardian_temp =
        Temp(std::env::temp_dir().join(format!("phoenix-guardian-e2e-{}", domain.deployment)));
    let guardian_key = SigningKey::from_bytes(&[44; 32]);
    let guardian_policy = GuardianPolicy {
        observer_keys: vec![worker_key(&guardian_key)],
        failures_threshold: 1,
        max_payments_per_window: 2,
        window_ns: 60_000_000_000,
        max_events_per_window: 8,
        max_worker_actions: 8,
        risk_quarantine_threshold: 80,
        max_event_age_ns: 60_000_000_000,
    };
    let audit_log = AuditLog::open(&guardian_temp.0, &domain, guardian_key.clone())?;
    let mut guardian_service = Guardian::new(plan.clone(), guardian_policy, audit_log)?;
    let mut security_chain = SandboxSecurityChain {
        observer: observer.clone(),
        guardian: guardian.clone(),
        domain: domain.clone(),
    };
    let warning_now = security_chain.now().await?;
    let warning = SecurityEvent::sign(
        SecurityEventBody {
            domain: domain.clone(),
            source_key: worker_key(&guardian_key),
            source_nonce: 1,
            evidence_id: digest(
                format!("backup-checkpoint:{}", backup_checkpoint.digest()?).as_bytes(),
            ),
            epoch: 1,
            issued_at: warning_now,
            kind: SecurityEventKind::RiskSignal { score: 75 },
        },
        &guardian_key,
    )?;
    let warning_decision = guardian_service
        .handle(&mut security_chain, warning.clone())
        .await?;
    ensure!(
        warning_decision == Decision::Observe,
        "Guardian unexpectedly quarantined the advisory warning"
    );
    control_event(
        "guardian_warning",
        json!({"decision":"Observe","score":75,"evidence_id":warning.body.evidence_id}),
    );

    let unauthorized_error = call(
        &worker,
        &attacker,
        &vault,
        "reserve_fenced_payment",
            json!({"task_id":domain.task_id,"operation_id":"attacker-payment","recipient":recipient.id(),"amount":"1000000000000000000000000","commitment":"aa".repeat(32),"epoch":"1"}),
        10_000_000_000_000_000_000_000,
    )
    .await
    .err()
    .context("Unauthorized payment unexpectedly succeeded")?;
    let unauthorized_reason = format!("{unauthorized_error:#}");
    ensure!(
        unauthorized_reason.contains("Executor only"),
        "Unexpected unauthorized-payment rejection: {unauthorized_reason}"
    );
    let authorization_evidence = digest(unauthorized_reason.as_bytes());
    control_event(
        "suspicious_payment_rejected",
        json!({"actor":attacker.id().to_string(),"operation_id":"attacker-payment","reason":"Executor only","evidence_id":authorization_evidence}),
    );
    let quarantine_now = security_chain.now().await?;
    let authorization_failure = SecurityEvent::sign(
        SecurityEventBody {
            domain: domain.clone(),
            source_key: worker_key(&guardian_key),
            source_nonce: 2,
            evidence_id: authorization_evidence.clone(),
            epoch: 1,
            issued_at: quarantine_now,
            kind: SecurityEventKind::AuthorizationFailure,
        },
        &guardian_key,
    )?;
    let quarantine_decision = guardian_service
        .handle(&mut security_chain, authorization_failure)
        .await?;
    ensure!(
        matches!(quarantine_decision, Decision::Quarantine { .. }),
        "Guardian did not quarantine the observed authorization failure"
    );
    let contained = security_chain.security_state().await?;
    ensure!(
        contained.task_paused
            && !contained.running
            && contained.epoch == 1
            && contained.task_epoch == 1,
        "Guardian quarantine did not fail closed"
    );
    rejected(
        &worker,
        &operator,
        &vault,
        "reserve_fenced_payment",
            json!({"task_id":domain.task_id,"operation_id":"after-quarantine","recipient":recipient.id(),"amount":"1000000000000000000000000","commitment":"bb".repeat(32),"epoch":"1"}),
        10_000_000_000_000_000_000_000,
        "Task paused",
    )
    .await?;
    ensure!(
        coordinator
            .tick(&mut chain, &mut verifier, &[])
            .await
            .is_err(),
        "Recovery coordinator continued while Guardian quarantine was active"
    );
    control_event(
        "guardian_quarantined",
        json!({"decision":"Quarantine","reason":"Repeated authorization failures","epoch":contained.epoch,"task_paused":contained.task_paused,"evidence_id":authorization_evidence}),
    );
    control_event(
        "demo_complete",
        json!({
            "complete":true,
            "network":"sandbox",
            "block_timestamp_ns":worker.view_block().await?.timestamp().to_string(),
        }),
    );
    eprintln!(
        "DEMO PASS: primary failure -> signed SENTINEL approval -> backup restore/fencing -> exactly-once REWIND settlement -> on-chain Sentinel receipt -> Guardian quarantine"
    );
    Ok(())
}
