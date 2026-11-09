//! End-to-end Stage A receipt test. All contracts and accounts are ephemeral sandbox state.
//! The SENTINEL observer evidence is explicitly not an on-chain REWIND proof.
use anyhow::{Context, Result, bail, ensure};
use ed25519_dalek::{Signer, SigningKey};
use near_jsonrpc_client::{JsonRpcClient, methods};
use near_primitives::types::Finality;
use near_workspaces::{Account, Contract, Worker, network::Sandbox, types::NearToken};
use phoenix_recovery::sentinel::{
    Action, ApprovalBody, ApprovalPolicy, FinalizedSettlementEvidence, RecoveryReceiptReview,
    Sentinel, SignedRecoveryReceipt, sign_approval, verify_recovery_receipt_evidence,
};
use phoenix_recovery::{
    AgentStatus, Domain, Effect, Payment, PaymentState, Plan, SignedCheckpoint, Snapshot,
    TaskState, digest, worker_key,
};
use serde_json::{Value, json};
use std::path::PathBuf;

const N: u128 = 1_000_000_000_000_000_000_000_000;
const TASK_BOND: u128 = 25_000_000_000_000_000_000_000;
const SENTINEL_BOND: u128 = 40_000_000_000_000_000_000_000;
const OP_BOND: u128 = 10_000_000_000_000_000_000_000;
const HEARTBEAT_TIMEOUT_NS: u64 = 60_000_000_000;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn wasm(name: &str) -> Result<Vec<u8>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../target/near")
        .join(name)
        .join(format!("{name}.wasm"));
    Ok(std::fs::read(&path)
        .with_context(|| format!("Missing built artifact {}", path.display()))?)
}

async fn call(
    who: &Account,
    contract: &Contract,
    method: &str,
    args: Value,
    deposit: u128,
) -> Result<Value> {
    let result = who
        .call(contract.id(), method)
        .args_json(args)
        .deposit(NearToken::from_yoctonear(deposit))
        .max_gas()
        .transact()
        .await?;
    if result.is_failure() {
        bail!(
            "{method} final execution failed on {}: {result:?}",
            contract.id()
        );
    }
    let bytes = result
        .into_result()
        .with_context(|| format!("{method} on {}", contract.id()))?
        .raw_bytes()?;
    if bytes.is_empty() {
        Ok(Value::Null)
    } else {
        Ok(serde_json::from_slice(&bytes)?)
    }
}

async fn rejected(
    who: &Account,
    contract: &Contract,
    method: &str,
    args: Value,
    reason: &str,
) -> Result<()> {
    let result = who
        .call(contract.id(), method)
        .args_json(args)
        .max_gas()
        .transact()
        .await?;
    ensure!(result.is_failure(), "{method} unexpectedly succeeded");
    ensure!(
        format!("{result:?}").contains(reason),
        "{method} rejected for unexpected reason: {result:?}"
    );
    Ok(())
}

async fn view(contract: &Contract, method: &str, args: Value) -> Result<Value> {
    Ok(contract
        .view(method)
        .args_json(args)
        .finality(near_workspaces::types::Finality::Final)
        .await?
        .json()?)
}

fn policy(
    domain: Domain,
    sentinel_key: &SigningKey,
    primary: &str,
    backup: &str,
    recipient: &str,
) -> ApprovalPolicy {
    ApprovalPolicy {
        domain,
        public_key: worker_key(sentinel_key),
        requester: "placeholder".into(), // replaced with the operator account below
        verifier: "placeholder".into(),  // replaced with the SENTINEL account below
        worker_keys: vec![primary.to_owned(), backup.to_owned()],
        last_nonce: 0,
        allowed_actions: vec![Action::Recovery, Action::Payment],
        allowed_recipients: vec![backup.to_owned(), recipient.to_owned()],
        max_payment: N.to_string(),
    }
}

fn signed_receipt(mut receipt: SignedRecoveryReceipt, key: &SigningKey) -> SignedRecoveryReceipt {
    receipt.signature = hex(&key.sign(&receipt.body.signing_bytes()).to_bytes());
    receipt
}

async fn finalized_block(
    worker: &Worker<Sandbox>,
) -> Result<(u64, String, near_workspaces::types::CryptoHash)> {
    let rpc = JsonRpcClient::connect(worker.rpc_addr());
    let response = rpc
        .call(methods::block::RpcBlockRequest {
            block_reference: Finality::Final.into(),
        })
        .await?;
    let hash: near_workspaces::types::CryptoHash = response.header.hash.to_string().parse()?;
    Ok((
        response.header.height,
        response.header.hash.to_string(),
        hash,
    ))
}

async fn advance_until_heartbeat_expires(
    worker: &Worker<Sandbox>,
    core: &Contract,
    agent_id: &str,
) -> Result<()> {
    let agent = view(core, "get_agent", json!({"agent_id":agent_id})).await?;
    let last_heartbeat: u64 = agent["heartbeat_at"]
        .as_str()
        .context("Missing primary heartbeat timestamp")?
        .parse()?;
    let timeout_ns: u64 = agent["timeout_ns"]
        .as_str()
        .context("Missing heartbeat timeout")?
        .parse()?;
    let expiry_threshold = last_heartbeat
        .checked_add(timeout_ns)
        .context("Heartbeat expiry timestamp overflow")?;
    let before = worker.view_block().await?;
    eprintln!(
        "Advancing sandbox time: heartbeat_at={}, current_block_timestamp={}, expiry_threshold={}, block_height={}",
        last_heartbeat,
        before.timestamp(),
        expiry_threshold,
        before.height()
    );

    // near-workspaces 0.23's Worker::fast_forward submits sandbox_fast_forward
    // but may return before finalized blocks reflect the requested time.
    // Request an ample height delta, then wait for finalized chain time.
    worker.fast_forward(1_000).await?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let block = worker.view_block().await?;
        if block.timestamp() >= expiry_threshold {
            eprintln!(
                "Sandbox heartbeat expired: heartbeat_at={}, current_block_timestamp={}, expiry_threshold={}, block_height={}",
                last_heartbeat,
                block.timestamp(),
                expiry_threshold,
                block.height()
            );
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            bail!(
                "Sandbox chain time did not expire the primary heartbeat: last_heartbeat_timestamp={}, current_block_timestamp={}, expiry_threshold={}, elapsed_ns={}, block_height={}",
                last_heartbeat,
                block.timestamp(),
                expiry_threshold,
                block.timestamp().saturating_sub(last_heartbeat),
                block.height()
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

async fn wait_for_finalized_payment(
    worker: &Worker<Sandbox>,
    vault: &Contract,
    recipient: &Account,
    operation_id: &str,
    starting_balance: u128,
    expected_amount: u128,
) -> Result<(Value, u64, String, near_workspaces::types::CryptoHash, u128)> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut advances = 0u64;
    loop {
        let (height, hash_string, block_hash) = finalized_block(worker).await?;
        let operation: Value = vault
            .view("get_operation")
            .args_json(json!({"operation_id":operation_id}))
            .block_hash(block_hash)
            .await?
            .json()?;
        let balance = recipient
            .view_account()
            .block_hash(block_hash)
            .await?
            .balance
            .as_yoctonear();
        let delta = balance.saturating_sub(starting_balance);

        match operation["state"].as_str() {
            Some("Succeeded") => {
                ensure!(
                    delta == expected_amount,
                    "REWIND says Succeeded at finalized block {height} ({hash_string}) but recipient balance delta is {delta}, expected {expected_amount}; op={operation}"
                );
                eprintln!(
                    "Confirmed REWIND settlement: operation={operation_id}, state=Succeeded, finalized_height={height}, finalized_hash={hash_string}, recipient_balance_delta={delta}"
                );
                return Ok((operation, height, hash_string, block_hash, balance));
            }
            Some("Failed") | Some("Uncertain") => {
                bail!(
                    "REWIND callback reached terminal/non-success state at finalized block {height} ({hash_string}); recipient balance delta={delta}; op={operation}"
                );
            }
            Some("Pending") => {}
            other => bail!(
                "Unexpected REWIND operation state {other:?} at finalized block {height} ({hash_string}); op={operation}"
            ),
        }

        if std::time::Instant::now() >= deadline || advances >= 120 {
            bail!(
                "REWIND callback did not finalize within the bounded wait: state={:?}, approved={:?}, execution_epoch={:?}, last_finalized_height={height}, last_finalized_hash={hash_string}, recipient_balance_delta={delta}, expected_delta={expected_amount}, block_advances={advances}, operation={operation}",
                operation["state"],
                operation["approved"],
                operation["execution_epoch"]
            );
        }

        // fast_forward requests advancement but near-workspaces may return
        // before a finalized block is queryable; the next loop verifies it.
        worker.fast_forward(1).await?;
        advances += 1;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

#[tokio::test]
async fn proof_of_recovery_receipt_end_to_end_and_adversarial_cases() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let core = worker.dev_deploy(&wasm("phoenix_core")?).await?;
    let vault = worker.dev_deploy(&wasm("rewind_vault")?).await?;
    let owner = worker.dev_create_account().await?;
    let operator = worker.dev_create_account().await?;
    let sentinel_account = worker.dev_create_account().await?;
    let recipient = worker.dev_create_account().await?;
    let attacker = worker.dev_create_account().await?;

    let primary_key = SigningKey::from_bytes(&[31; 32]);
    let backup_key = SigningKey::from_bytes(&[32; 32]);
    let sentinel_key = SigningKey::from_bytes(&[33; 32]);
    let primary_identity = worker_key(&primary_key);
    let backup_identity = worker_key(&backup_key);
    let task_id = "stage-a-proof";
    let core_id = core.id().as_str().to_owned();
    let vault_id = vault.id().as_str().to_owned();
    let operator_id = operator.id().as_str().to_owned();
    let sentinel_id = sentinel_account.id().as_str().to_owned();
    let recipient_id = recipient.id().as_str().to_owned();

    call(
        &owner,
        &core,
        "new",
        json!({"owner":owner.id(),"guardian":sentinel_account.id()}),
        0,
    )
    .await?;
    call(
        &owner,
        &vault,
        "new",
        json!({"owner":owner.id(),"guardian":sentinel_account.id()}),
        0,
    )
    .await?;

    let now = worker.view_block().await?.timestamp();
    let domain = Domain {
        network: "sandbox".into(),
        deployment: "stage-a-e2e".into(),
        core_id: core_id.clone(),
        vault_id: vault_id.clone(),
        agent_id: operator_id.clone(),
        task_id: task_id.into(),
        execution_id: "stage-a-execution".into(),
        code_digest: "aa".repeat(32),
        policy_digest: "bb".repeat(32),
    };
    let effect = Effect {
        name: "deliver-result".into(),
        recipient: recipient_id.clone(),
        amount: N.to_string(),
    };
    let plan = Plan {
        domain: domain.clone(),
        worker_keys: vec![primary_identity.clone(), backup_identity.clone()],
        effects: vec![effect.clone()],
    };
    let mut sentinel_policy = policy(
        domain.clone(),
        &sentinel_key,
        &primary_identity,
        &backup_identity,
        &recipient_id,
    );
    sentinel_policy.requester = operator_id.clone();
    sentinel_policy.verifier = sentinel_id.clone();

    call(
        &owner,
        &core,
        "register_agent",
        json!({"agent_id":operator.id(),"operator":operator.id(),"sentinel":sentinel_account.id(),"timeout_ns":HEARTBEAT_TIMEOUT_NS.to_string()}),
        0,
    )
    .await?;
    call(
        &owner,
        &core,
        "configure_stateflow",
        json!({"agent_id":operator.id(),"task_id":task_id,"worker_key":primary_identity,"backup_keys":[backup_identity]}),
        0,
    )
    .await?;
    call(
        &owner,
        &core,
        "configure_sentinel",
        json!({"agent_id":operator.id(),"policy":sentinel_policy}),
        0,
    )
    .await?;

    // The actual signed checkpoint is anchored by Core and later verified by SENTINEL.
    let checkpoint = SignedCheckpoint::sign(
        phoenix_recovery::CheckpointBody {
            domain: domain.clone(),
            plan_digest: digest(&serde_json::to_vec(&plan)?),
            epoch: 0,
            sequence: 1,
            previous_digest: None,
            worker_key: primary_identity.clone(),
            issued_at: now,
            expires_at: now + 3_600_000_000_000,
            state: TaskState {
                completed_steps: 1,
                result: "primary checkpoint".into(),
                requested_effects: vec![effect.name.clone()],
            },
        },
        &primary_key,
    )?;
    let checkpoint_hash = checkpoint.digest()?;
    // Setup uses separate sandbox receipts. Refresh the lease immediately
    // before the first checkpoint rather than relying on registration time.
    call(
        &operator,
        &core,
        "heartbeat",
        json!({"agent_id":operator.id(),"generation":"0"}),
        0,
    )
    .await?;
    call(
        &operator,
        &core,
        "commit_checkpoint",
        json!({"agent_id":operator.id(),"generation":"0","sequence":"1","digest":checkpoint_hash,"previous_digest":null,"expires_at":(now + 3_600_000_000_000).to_string()}),
        0,
    )
    .await?;

    // Fresh local escrow. Only the designated operator/verifier can act on it.
    call(
        &owner,
        &vault,
        "create_task",
        json!({"task_id":task_id,"executor":operator.id(),"verifier":sentinel_account.id(),"recipients":[{"account_id":recipient.id(),"limit":N.to_string()}],"escrow_amount":(2*N).to_string(),"expires_at":(now + 86_400_000_000_000).to_string()}),
        2 * N + TASK_BOND,
    )
    .await?;
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
        json!({"task_id":task_id,"policy":sentinel_policy.clone()}),
        SENTINEL_BOND,
    )
    .await?;
    // Simulate primary failure using finalized chain time, not block-count assumptions.
    advance_until_heartbeat_expires(&worker, &core, operator.id().as_str()).await?;
    call(
        &attacker,
        &core,
        "report_crash",
        json!({"agent_id":operator.id()}),
        0,
    )
    .await?;
    call(
        &sentinel_account,
        &vault,
        "advance_task_epoch",
        json!({"task_id":task_id,"expected_epoch":"0"}),
        0,
    )
    .await?;
    let approval_time = worker.view_block().await?.timestamp();
    let recovery_approval = sign_approval(
        ApprovalBody {
            domain: domain.clone(),
            action: Action::Recovery,
            requester: operator_id.clone(),
            subject_key: primary_identity.clone(),
            epoch: 0,
            security_revision: 0,
            checkpoint_digest: checkpoint_hash.clone(),
            operation_id: checkpoint_hash.clone(),
            recipient: backup_identity.clone(),
            amount: "0".into(),
            commitment: checkpoint_hash.clone(),
            nonce: 1,
            issued_at: approval_time,
            expires_at: approval_time + 30_000_000_000,
        },
        &sentinel_key,
    );
    // NEAR JSON ABI uses the Rust argument name as the top-level object key.
    // Missing and malformed wrappers must fail before authorization/signature logic.
    rejected(
        &sentinel_account,
        &core,
        "approve_signed_recovery",
        json!({}),
        "missing field",
    )
    .await?;
    rejected(
        &sentinel_account,
        &core,
        "approve_signed_recovery",
        json!({"approval":{}}),
        "missing field",
    )
    .await?;
    call(
        &sentinel_account,
        &core,
        "approve_signed_recovery",
        json!({"approval":recovery_approval}),
        0,
    )
    .await?;
    call(
        &operator,
        &core,
        "recover_checkpoint",
        json!({"agent_id":operator.id(),"generation":"0","digest":checkpoint_hash,"backup_key":backup_identity}),
        0,
    )
    .await?;
    let activation_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let (active_agent, active_flow) = loop {
        let agent_state = view(&core, "get_agent", json!({"agent_id":operator.id()})).await?;
        let flow_state = view(&core, "get_stateflow", json!({"agent_id":operator.id()})).await?;
        let activated = agent_state["generation"] == "1"
            && agent_state["status"] == "Running"
            && agent_state["recovery_approved"] == false
            && flow_state["worker_key"] == backup_identity
            && flow_state["grant"].is_null();
        if activated {
            break (agent_state, flow_state);
        }
        if std::time::Instant::now() >= activation_deadline {
            bail!(
                "Authorized backup activation was not visible after finalized reads: agent={agent_state:#}, stateflow={flow_state:#}"
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    };
    eprintln!(
        "Core post-recovery state: get_agent={active_agent:#}; get_stateflow={active_flow:#}"
    );
    ensure!(
        active_agent["generation"] == "1" && active_agent["status"] == "Running",
        "Backup activation state unexpected: generation/epoch={:?}, status={:?}, worker_id={:?}, recovery_approved={:?}, agent={active_agent:#}, stateflow={active_flow:#}",
        active_agent["generation"],
        active_agent["status"],
        active_flow["worker_key"],
        active_agent["recovery_approved"]
    );
    ensure!(active_flow["worker_key"] == backup_identity);

    // Backup settles the exact planned operation through REWIND's fenced flow.
    let payment_id = plan.payment_id(&effect)?;
    call(
        &operator,
        &vault,
        "reserve_fenced_payment",
        json!({"task_id":task_id,"operation_id":payment_id,"recipient":recipient.id(),"amount":N.to_string(),"commitment":payment_id,"epoch":"1"}),
        OP_BOND,
    )
    .await?;
    let payment_approval_time = worker.view_block().await?.timestamp();
    let payment_approval = sign_approval(
        ApprovalBody {
            domain: domain.clone(),
            action: Action::Payment,
            requester: operator_id.clone(),
            subject_key: backup_identity.clone(),
            epoch: 1,
            security_revision: 0,
            checkpoint_digest: checkpoint_hash.clone(),
            operation_id: payment_id.clone(),
            recipient: recipient_id.clone(),
            amount: N.to_string(),
            commitment: payment_id.clone(),
            nonce: 1,
            issued_at: payment_approval_time,
            expires_at: payment_approval_time + 30_000_000_000,
        },
        &sentinel_key,
    );
    call(
        &sentinel_account,
        &vault,
        "approve_signed_payment",
        json!({"approval":payment_approval}),
        0,
    )
    .await?;
    let (_, _, balance_checkpoint) = finalized_block(&worker).await?;
    let recipient_balance_before = recipient
        .view_account()
        .block_hash(balance_checkpoint)
        .await?
        .balance
        .as_yoctonear();
    let settle_return = call(
        &operator,
        &vault,
        "settle_fenced_payment",
        json!({"operation_id":payment_id,"epoch":"1"}),
        0,
    )
    .await?;
    eprintln!("REWIND settle transaction/callback return value: {settle_return}");

    // Only finalized Succeeded plus the exact recipient balance increase counts
    // as paid. Pending and Uncertain remain failures for this demo assertion.
    let (operation, block_height, block_hash, _, recipient_balance_after) =
        wait_for_finalized_payment(
            &worker,
            &vault,
            &recipient,
            &payment_id,
            recipient_balance_before,
            N,
        )
        .await?;
    ensure!(
        settle_return == true,
        "REWIND callback returned {settle_return}, while finalized operation state is {operation}"
    );
    ensure!(operation["task_id"] == task_id && operation["recipient"] == recipient_id);
    ensure!(operation["execution_epoch"] == "1" && operation["commitment"] == payment_id);
    ensure!(
        operation["approved"] == false,
        "Callback did not consume approval"
    );

    // A replay must be rejected, and must not change the recipient's balance.
    rejected(
        &operator,
        &vault,
        "settle_fenced_payment",
        json!({"operation_id":payment_id,"epoch":"1"}),
        "Operation not reserved",
    )
    .await?;
    let (_, _, duplicate_check_hash) = finalized_block(&worker).await?;
    let recipient_balance_after_duplicate = recipient
        .view_account()
        .block_hash(duplicate_check_hash)
        .await?
        .balance
        .as_yoctonear();
    ensure!(
        recipient_balance_after_duplicate == recipient_balance_after,
        "Duplicate settlement changed recipient balance: before_duplicate={recipient_balance_after}, after_duplicate={recipient_balance_after_duplicate}"
    );
    let payment = Payment {
        task_id: operation["task_id"]
            .as_str()
            .context("Missing operation task")?
            .into(),
        recipient: operation["recipient"]
            .as_str()
            .context("Missing operation recipient")?
            .into(),
        amount: operation["amount"]
            .as_str()
            .context("Missing operation amount")?
            .into(),
        commitment: operation["commitment"]
            .as_str()
            .context("Missing operation commitment")?
            .into(),
        epoch: Some(
            operation["execution_epoch"]
                .as_str()
                .context("Missing operation epoch")?
                .parse()?,
        ),
        approved: operation["approved"]
            .as_bool()
            .context("Missing approval state")?,
        state: PaymentState::Succeeded,
    };
    eprintln!(
        "Finalized REWIND payment evidence: approved_flag={}, amount={}, expected_amount={}",
        payment.approved, payment.amount, N
    );
    // REWIND consumes the live approval flag in its successful private callback.
    // Success plus the finalized on-chain operation and balance delta are the evidence.
    ensure!(
        !payment.approved && payment.amount == N.to_string(),
        "Finalized payment fields mismatch: approved_flag={}, amount={}, expected_amount={}",
        payment.approved,
        payment.amount,
        N
    );
    let evidence = FinalizedSettlementEvidence {
        task_id: task_id.into(),
        settlement_reference: payment_id.clone(),
        outcome: PaymentState::Succeeded,
        recipient: payment.recipient.clone(),
        amount: payment.amount.clone(),
        execution_epoch: payment.epoch,
        block_height,
        block_hash,
    };

    let final_block = worker.view_block().await?;
    let flow_head = &active_flow["head"];
    let active = Snapshot {
        now: final_block.timestamp(),
        paused: false,
        status: AgentStatus::Running,
        epoch: 1,
        heartbeat_at: active_agent["heartbeat_at"]
            .as_str()
            .context("Missing heartbeat")?
            .parse()?,
        timeout_ns: active_agent["timeout_ns"]
            .as_str()
            .context("Missing timeout")?
            .parse()?,
        worker_key: backup_identity.clone(),
        backups: vec![],
        head: Some(phoenix_recovery::Head {
            digest: flow_head["digest"]
                .as_str()
                .context("Missing checkpoint head")?
                .into(),
            epoch: flow_head["generation"]
                .as_str()
                .context("Missing head epoch")?
                .parse()?,
            sequence: flow_head["sequence"]
                .as_str()
                .context("Missing checkpoint sequence")?
                .parse()?,
            expires_at: flow_head["expires_at"]
                .as_str()
                .context("Missing checkpoint expiry")?
                .parse()?,
        }),
    };
    let mut receipt_policy = sentinel_policy.clone();
    receipt_policy.last_nonce = 1; // the on-chain recovery approval consumed nonce one
    let sentinel = Sentinel::new(plan.clone(), receipt_policy.clone(), sentinel_key.clone())?;
    let receipt = sentinel.recovery_receipt(RecoveryReceiptReview {
        checkpoint: &checkpoint,
        active: &active,
        settlement: &payment,
        evidence: &evidence,
        security_revision: 0,
    })?;
    verify_recovery_receipt_evidence(&receipt, &evidence, &receipt_policy)?;

    let transition = view(
        &core,
        "get_recovery_receipt",
        json!({"agent_id":operator.id(),"epoch_to":"1"}),
    )
    .await?;
    let local_checkpoint_digest = checkpoint.digest()?;
    let stateflow_checkpoint_digest = active_flow["head"]["digest"]
        .as_str()
        .context("Missing on-chain STATEFLOW checkpoint digest")?;
    let recovery_checkpoint_digest = transition["checkpoint_hash"]
        .as_str()
        .context("Missing on-chain recovery checkpoint digest")?;
    eprintln!(
        "Proof checkpoint digests: local_signed_checkpoint={}, stateflow_head={}, recovery_transition={}, sentinel_receipt={}",
        local_checkpoint_digest,
        stateflow_checkpoint_digest,
        recovery_checkpoint_digest,
        receipt.body.checkpoint_hash
    );
    ensure!(
        local_checkpoint_digest == checkpoint_hash
            && stateflow_checkpoint_digest == checkpoint_hash
            && recovery_checkpoint_digest == checkpoint_hash
            && receipt.body.checkpoint_hash == checkpoint_hash,
        "Checkpoint digest sources diverged: local={local_checkpoint_digest}, stateflow={stateflow_checkpoint_digest}, transition={recovery_checkpoint_digest}, sentinel={}",
        receipt.body.checkpoint_hash
    );

    // Trusted-observer evidence mismatch must not be signed by SENTINEL.
    let mut mismatched_evidence = evidence.clone();
    mismatched_evidence.amount = (N + 1).to_string();
    ensure!(
        sentinel
            .recovery_receipt(RecoveryReceiptReview {
                checkpoint: &checkpoint,
                active: &active,
                settlement: &payment,
                evidence: &mismatched_evidence,
                security_revision: 0,
            })
            .is_err(),
        "SENTINEL accepted mismatched settlement evidence"
    );

    // Correctly signed but altered checkpoint commitment is rejected against Core's stored row.
    let mut altered_checkpoint = receipt.clone();
    altered_checkpoint.body.checkpoint_hash = "ee".repeat(32);
    altered_checkpoint = signed_receipt(altered_checkpoint, &sentinel_key);
    rejected(
        &sentinel_account,
        &core,
        "record_recovery_receipt",
        json!({"receipt":altered_checkpoint}),
        "Receipt checkpoint mismatch",
    )
    .await?;

    // A forged signature is rejected even when all receipt fields are otherwise valid.
    let mut forged = receipt.clone();
    forged.signature = "00".repeat(64);
    rejected(
        &sentinel_account,
        &core,
        "record_recovery_receipt",
        json!({"receipt":forged}),
        "Forged recovery receipt",
    )
    .await?;

    // Stale epoch has no matching transition row.
    let mut stale = receipt.clone();
    stale.body.epoch_from = 1;
    stale.body.epoch_to = 2;
    stale = signed_receipt(stale, &sentinel_key);
    rejected(
        &sentinel_account,
        &core,
        "record_recovery_receipt",
        json!({"receipt":stale}),
        "Recovery transition not found",
    )
    .await?;

    let receipt_json = json!({"receipt":receipt});
    call(
        &sentinel_account,
        &core,
        "record_recovery_receipt",
        receipt_json.clone(),
        0,
    )
    .await?;
    rejected(
        &sentinel_account,
        &core,
        "record_recovery_receipt",
        receipt_json,
        "Receipt already verified",
    )
    .await?;

    // Read-only public proof is compared with the finalized REWIND operation.
    let proof = view(
        &core,
        "get_recovery_receipt",
        json!({"agent_id":operator.id(),"epoch_to":"1"}),
    )
    .await?;
    ensure!(proof["task_id"] == task_id);
    ensure!(proof["checkpoint_hash"] == checkpoint_hash);
    ensure!(proof["primary_identity"] == primary_identity);
    ensure!(proof["backup_identity"] == backup_identity);
    ensure!(proof["epoch_from"] == "0" && proof["epoch_to"] == "1");
    ensure!(proof["verified_by"] == sentinel_id);
    ensure!(proof["signed_receipt"]["body"]["settlement_reference"] == payment_id);
    ensure!(proof["signed_receipt"]["body"]["settlement_outcome"] == "Succeeded");
    ensure!(proof["signed_receipt"]["body"]["settlement_block_height"] == block_height);
    ensure!(proof["signed_receipt"]["body"]["checkpoint_hash"] == checkpoint_hash);
    ensure!(proof["signed_receipt"]["signature"] == receipt.signature);
    let stored_receipt: SignedRecoveryReceipt =
        serde_json::from_value(proof["signed_receipt"].clone())?;
    verify_recovery_receipt_evidence(&stored_receipt, &evidence, &receipt_policy)?;

    // Explicitly assert recipient received funds and final escrow accounting.
    let operation_after = view(&vault, "get_operation", json!({"operation_id":payment_id})).await?;
    let task_after = view(&vault, "get_task", json!({"task_id":task_id})).await?;
    ensure!(operation_after["state"] == "Succeeded");
    ensure!(task_after["paid"] == N.to_string());
    ensure!(
        recipient_balance_after_duplicate.saturating_sub(recipient_balance_before) == N,
        "Recipient net balance change was not exactly one payment"
    );
    eprintln!(
        "Stage A sandbox receipt: task={task_id}, epoch=0->1, settlement={payment_id}, final block={block_height}"
    );
    Ok(())
}
