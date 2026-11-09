//! Local-only adapter: Worker<Sandbox> cannot target mainnet/testnet.
//! Observer performs reads; coordinator/sentinel use distinct account handles.
//! near-workspaces retains sandbox infrastructure/deployment keys in this test harness.
use anyhow::{Context, Result, ensure};
use ed25519_dalek::SigningKey;
use near_jsonrpc_client::{JsonRpcClient, methods};
use near_primitives::{types::Finality as RpcFinality, views::TxExecutionStatus};
use near_workspaces::{Account, Contract, Worker, network::Sandbox, types::NearToken};
use phoenix_recovery::sentinel::{Action, ApprovalBody, ApprovalPolicy, sign_approval};
use phoenix_recovery::*;
use serde_json::{Value, json};

pub async fn call(
    worker: &Worker<Sandbox>,
    account: &Account,
    contract: &Contract,
    method: &str,
    args: Value,
    deposit: u128,
) -> Result<Value> {
    let address = worker.rpc_addr();
    ensure!(
        address.starts_with("http://127.0.0.1:") || address.starts_with("http://localhost:"),
        "Only loopback sandbox RPC is allowed"
    );
    let result = account
        .call(contract.id(), method)
        .args_json(args)
        .deposit(NearToken::from_yoctonear(deposit))
        .max_gas()
        .transact()
        .await?;
    let finalized = JsonRpcClient::connect(address)
        .call(methods::tx::RpcTransactionStatusRequest {
            transaction_info: methods::tx::TransactionInfo::TransactionId {
                tx_hash: result
                    .outcome()
                    .transaction_hash
                    .to_string()
                    .parse::<near_primitives::hash::CryptoHash>()
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?,
                sender_account_id: account.id().as_str().parse()?,
            },
            wait_until: TxExecutionStatus::Final,
        })
        .await?;
    ensure!(
        matches!(finalized.final_execution_status, TxExecutionStatus::Final),
        "Transaction not final"
    );
    let raw = result
        .into_result()
        .with_context(|| format!("{method} on {}", contract.id()))?
        .raw_bytes()?;
    if raw.is_empty() {
        Ok(Value::Null)
    } else {
        Ok(serde_json::from_slice(&raw)?)
    }
}
pub async fn rejected(
    worker: &Worker<Sandbox>,
    account: &Account,
    contract: &Contract,
    method: &str,
    args: Value,
    deposit: u128,
    reason: &str,
) -> Result<()> {
    let error = call(worker, account, contract, method, args, deposit)
        .await
        .expect_err("Unauthorized/duplicate action unexpectedly succeeded");
    ensure!(
        format!("{error:#}").contains(reason),
        "Unexpected rejection: {error:#}"
    );
    Ok(())
}
pub async fn view(contract: &Contract, method: &str, args: Value) -> Result<Value> {
    Ok(contract
        .view(method)
        .args_json(args)
        .finality(near_workspaces::types::Finality::Final)
        .await?
        .json()?)
}
fn number(value: &Value) -> Result<u64> {
    Ok(value
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Expected U64 string"))?
        .parse()?)
}
fn string(value: &Value) -> Result<String> {
    Ok(value
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Expected string"))?
        .to_owned())
}
#[derive(Clone)]
pub struct Observer {
    pub worker: Worker<Sandbox>,
    pub core: Contract,
    pub vault: Contract,
    pub domain: Domain,
    pub operator_id: String,
    pub sentinel_id: String,
}
impl Observer {
    pub async fn snapshot(&self) -> Result<Snapshot> {
        ensure!(
            self.domain.network == "sandbox"
                && self.domain.core_id == self.core.id().as_str()
                && self.domain.vault_id == self.vault.id().as_str(),
            "Adapter domain mismatch"
        );
        let address = self.worker.rpc_addr();
        ensure!(
            address.starts_with("http://127.0.0.1:") || address.starts_with("http://localhost:"),
            "Only loopback sandbox RPC is allowed"
        );
        let block = JsonRpcClient::connect(address)
            .call(methods::block::RpcBlockRequest {
                block_reference: RpcFinality::Final.into(),
            })
            .await?;
        let block_hash: near_workspaces::types::CryptoHash =
            block.header.hash.to_string().parse()?;
        let agent: Value = self
            .core
            .view("get_agent")
            .args_json(json!({"agent_id":self.domain.agent_id}))
            .block_hash(block_hash)
            .await?
            .json()?;
        ensure!(
            agent["operator"] == self.operator_id && agent["sentinel"] == self.sentinel_id,
            "Chain role mismatch"
        );
        let flow: Value = self
            .core
            .view("get_stateflow")
            .args_json(json!({"agent_id":self.domain.agent_id}))
            .block_hash(block_hash)
            .await?
            .json()?;
        ensure!(
            flow["task_id"] == self.domain.task_id,
            "Chain task mismatch"
        );
        let head = if flow["head"].is_null() {
            None
        } else {
            Some(Head {
                digest: string(&flow["head"]["digest"])?,
                epoch: number(&flow["head"]["generation"])?,
                sequence: number(&flow["head"]["sequence"])?,
                expires_at: number(&flow["head"]["expires_at"])?,
            })
        };
        let status = match agent["status"].as_str() {
            Some("Running") => AgentStatus::Running,
            Some("Crashed") => AgentStatus::Crashed,
            Some("Contained") => AgentStatus::Contained,
            _ => anyhow::bail!("Unknown agent status"),
        };
        Ok(Snapshot {
            now: block.header.timestamp_nanosec,
            paused: self
                .core
                .view("is_paused")
                .args_json(json!({}))
                .block_hash(block_hash)
                .await?
                .json::<Value>()?
                .as_bool()
                .ok_or_else(|| anyhow::anyhow!("Invalid pause status"))?,
            status,
            epoch: number(&agent["generation"])?,
            heartbeat_at: number(&agent["heartbeat_at"])?,
            timeout_ns: number(&agent["timeout_ns"])?,
            worker_key: string(&flow["worker_key"])?,
            backups: serde_json::from_value(flow["backup_keys"].clone())?,
            head,
        })
    }
    pub async fn flow(&self) -> Result<Value> {
        view(
            &self.core,
            "get_stateflow",
            json!({"agent_id":self.domain.agent_id}),
        )
        .await
    }
    pub async fn task(&self) -> Result<Value> {
        let task = view(
            &self.vault,
            "get_task",
            json!({"task_id":self.domain.task_id}),
        )
        .await?;
        ensure!(
            task["executor"] == self.operator_id && task["verifier"] == self.sentinel_id,
            "Vault role mismatch"
        );
        Ok(task)
    }
    pub async fn payment(&self, id: &str) -> Result<Option<Payment>> {
        let op = view(&self.vault, "get_operation", json!({"operation_id":id})).await?;
        if op.is_null() {
            return Ok(None);
        }
        ensure!(op["kind"] == "Payment", "Operation is not a payment");
        let state = match op["state"].as_str() {
            Some("Reserved") => PaymentState::Reserved,
            Some("Pending") => PaymentState::Pending,
            Some("Uncertain") => PaymentState::Uncertain,
            Some("Succeeded") => PaymentState::Succeeded,
            Some("Failed") => PaymentState::Failed,
            Some("Cancelled") => PaymentState::Cancelled,
            _ => anyhow::bail!("Unknown operation state"),
        };
        Ok(Some(Payment {
            task_id: string(&op["task_id"])?,
            recipient: string(&op["recipient"])?,
            amount: string(&op["amount"])?,
            commitment: string(&op["commitment"])?,
            epoch: if op["execution_epoch"].is_null() {
                None
            } else {
                Some(number(&op["execution_epoch"])?)
            },
            approved: op["approved"]
                .as_bool()
                .ok_or_else(|| anyhow::anyhow!("Invalid approval"))?,
            state,
        }))
    }
}
pub struct SandboxChain {
    pub observer: Observer,
    pub operator: Account,
    pub watcher: Account,
}
impl Chain for SandboxChain {
    fn domain(&self) -> &Domain {
        &self.observer.domain
    }
    async fn snapshot(&self) -> Result<Snapshot> {
        self.observer.snapshot().await
    }
    async fn heartbeat(&mut self, epoch: u64) -> Result<()> {
        call(
            &self.observer.worker,
            &self.operator,
            &self.observer.core,
            "heartbeat",
            json!({"agent_id":self.observer.domain.agent_id,"generation":epoch.to_string()}),
            0,
        )
        .await?;
        Ok(())
    }
    async fn commit(&mut self, cp: &SignedCheckpoint) -> Result<()> {
        call(&self.observer.worker,&self.operator,&self.observer.core,"commit_checkpoint",json!({"agent_id":self.observer.domain.agent_id,"generation":cp.body.epoch.to_string(),"sequence":cp.body.sequence.to_string(),"digest":cp.digest()?,"previous_digest":cp.body.previous_digest,"expires_at":cp.body.expires_at.to_string()}),0).await?;
        Ok(())
    }
    async fn report_crash(&mut self) -> Result<()> {
        call(
            &self.observer.worker,
            &self.watcher,
            &self.observer.core,
            "report_crash",
            json!({"agent_id":self.observer.domain.agent_id}),
            0,
        )
        .await?;
        Ok(())
    }
    async fn recover(&mut self, epoch: u64, digest: &str, backup: &str) -> Result<()> {
        call(&self.observer.worker,&self.operator,&self.observer.core,"recover_checkpoint",json!({"agent_id":self.observer.domain.agent_id,"generation":epoch.to_string(),"digest":digest,"backup_key":backup}),0).await?;
        Ok(())
    }
    async fn payment(&self, id: &str) -> Result<Option<Payment>> {
        self.observer.payment(id).await
    }
    async fn reserve(&mut self, id: &str, effect: &Effect, epoch: u64) -> Result<()> {
        call(&self.observer.worker,&self.operator,&self.observer.vault,"reserve_fenced_payment",json!({"task_id":self.observer.domain.task_id,"operation_id":id,"recipient":effect.recipient,"amount":effect.amount,"commitment":id,"epoch":epoch.to_string()}),10_000_000_000_000_000_000_000).await?;
        Ok(())
    }
    async fn settle(&mut self, id: &str, epoch: u64) -> Result<()> {
        call(
            &self.observer.worker,
            &self.operator,
            &self.observer.vault,
            "settle_fenced_payment",
            json!({"operation_id":id,"epoch":epoch.to_string()}),
            0,
        )
        .await?;
        Ok(())
    }
}
pub struct SandboxVerifier {
    pub observer: Observer,
    pub signer: Account,
    pub plan: Plan,
    pub policy: ApprovalPolicy,
    pub sentinel_key: SigningKey,
}
impl Verifier for SandboxVerifier {
    async fn authorize_recovery(&mut self, cp: &SignedCheckpoint, backup: &str) -> Result<()> {
        ensure!(
            self.plan.domain == self.observer.domain,
            "Verifier adapter domain mismatch"
        );
        let snapshot = self.observer.snapshot().await?;
        ensure!(
            !snapshot.paused
                && snapshot.status == AgentStatus::Crashed
                && snapshot.epoch == cp.body.epoch,
            "Recovery not eligible"
        );
        verify_anchor(cp, &self.plan, &snapshot)?;
        ensure!(
            snapshot.backups.contains(&backup.to_owned()),
            "Backup not authorized"
        );
        ensure!(
            self.signer.id().as_str() == self.observer.sentinel_id,
            "Wrong sentinel signer"
        );
        ensure!(
            self.policy.domain == self.plan.domain
                && self.policy.requester == self.observer.operator_id
                && self.policy.verifier == self.observer.sentinel_id
                && self.policy.public_key == worker_key(&self.sentinel_key),
            "SENTINEL policy mismatch"
        );
        let next = snapshot
            .epoch
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("Epoch overflow"))?;
        let task = self.observer.task().await?;
        let vault_epoch = number(&task["execution_epoch"])?;
        // Signed SENTINEL approval is independently checked by Core before
        // STATEFLOW can grant the backup transition.
        let now = snapshot.now;
        let approval = sign_approval(
            ApprovalBody {
                domain: self.plan.domain.clone(),
                action: Action::Recovery,
                requester: self.observer.operator_id.clone(),
                subject_key: cp.body.worker_key.clone(),
                epoch: snapshot.epoch,
                security_revision: 0,
                checkpoint_digest: cp.digest()?,
                operation_id: cp.digest()?,
                recipient: backup.to_owned(),
                amount: "0".into(),
                commitment: cp.digest()?,
                nonce: 1,
                issued_at: now,
                expires_at: now
                    .checked_add(30_000_000_000)
                    .ok_or_else(|| anyhow::anyhow!("Approval expiry overflow"))?,
            },
            &self.sentinel_key,
        );
        let flow = self.observer.flow().await?;
        if flow["grant"].is_null() {
            call(
                &self.observer.worker,
                &self.signer,
                &self.observer.core,
                "approve_signed_recovery",
                json!({"approval":approval}),
                0,
            )
            .await?;
        }

        // Fence old spending after approval and before the Core transition.
        // Retry after a lost response is idempotent.
        if vault_epoch == snapshot.epoch {
            call(&self.observer.worker,&self.signer,&self.observer.vault,"advance_task_epoch",json!({"task_id":self.plan.domain.task_id,"expected_epoch":snapshot.epoch.to_string()}),0).await?;
        } else {
            ensure!(vault_epoch == next, "Vault epoch diverged");
        }
        let flow = self.observer.flow().await?;
        ensure!(
            flow["grant"]["digest"] == cp.digest()?
                && flow["grant"]["backup_key"] == backup
                && number(&flow["grant"]["generation"])? == snapshot.epoch,
            "Conflicting or missing signed recovery grant"
        );
        Ok(())
    }
    async fn authorize_payment(
        &mut self,
        cp: &SignedCheckpoint,
        session: &Session,
        effect: &Effect,
    ) -> Result<()> {
        ensure!(
            self.plan.domain == self.observer.domain,
            "Verifier adapter domain mismatch"
        );
        let snapshot = self.observer.snapshot().await?;
        ensure!(
            !snapshot.paused
                && snapshot.status == AgentStatus::Running
                && snapshot.now.saturating_sub(snapshot.heartbeat_at) < snapshot.timeout_ns,
            "Agent not live"
        );
        verify_anchor(cp, &self.plan, &snapshot)?;
        ensure!(
            snapshot.epoch == session.epoch
                && snapshot.worker_key == session.worker_key
                && cp.digest()? == session.checkpoint_digest,
            "Payment fence mismatch"
        );
        ensure!(
            cp.body.state.requested_effects.contains(&effect.name),
            "Effect not requested"
        );
        let id = self.plan.payment_id(effect)?;
        let task = self.observer.task().await?;
        ensure!(
            number(&task["execution_epoch"])? == session.epoch,
            "Vault fence mismatch"
        );
        let op = self
            .observer
            .payment(&id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("No reservation"))?;
        ensure!(
            op.state == PaymentState::Reserved
                && op.task_id == self.plan.domain.task_id
                && op.recipient == effect.recipient
                && op.amount == effect.amount
                && op.commitment == id,
            "Reserved intent mismatch"
        );
        if !op.approved || op.epoch != Some(session.epoch) {
            let now = snapshot.now;
            let approval = sign_approval(
                ApprovalBody {
                    domain: self.plan.domain.clone(),
                    action: Action::Payment,
                    requester: self.observer.operator_id.clone(),
                    subject_key: session.worker_key.clone(),
                    epoch: session.epoch,
                    security_revision: 0,
                    checkpoint_digest: cp.digest()?,
                    operation_id: id.clone(),
                    recipient: effect.recipient.clone(),
                    amount: effect.amount.clone(),
                    commitment: id.clone(),
                    nonce: 1,
                    issued_at: now,
                    expires_at: now
                        .checked_add(30_000_000_000)
                        .ok_or_else(|| anyhow::anyhow!("Approval expiry overflow"))?,
                },
                &self.sentinel_key,
            );
            call(
                &self.observer.worker,
                &self.signer,
                &self.observer.vault,
                "approve_signed_payment",
                json!({"approval":approval}),
                0,
            )
            .await?;
        }
        Ok(())
    }
}
