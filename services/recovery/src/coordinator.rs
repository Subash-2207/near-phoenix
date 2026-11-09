use crate::stateflow::*;
use anyhow::{Result, ensure};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AgentStatus {
    Running,
    Crashed,
    Contained,
}
#[derive(Clone, Debug)]
pub struct Head {
    pub digest: String,
    pub epoch: u64,
    pub sequence: u64,
    pub expires_at: u64,
}
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub now: u64,
    pub paused: bool,
    pub status: AgentStatus,
    pub epoch: u64,
    pub heartbeat_at: u64,
    pub timeout_ns: u64,
    pub worker_key: String,
    pub backups: Vec<String>,
    pub head: Option<Head>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum PaymentState {
    Reserved,
    Pending,
    Uncertain,
    Succeeded,
    Failed,
    Cancelled,
}
#[derive(Clone, Debug)]
pub struct Payment {
    pub task_id: String,
    pub recipient: String,
    pub amount: String,
    pub commitment: String,
    pub epoch: Option<u64>,
    pub approved: bool,
    pub state: PaymentState,
}
/// Implementations must use finalized local-chain observations and authenticated
/// coordinator keys. A transport error must propagate, never imply a failed transfer.
pub trait Chain {
    fn domain(&self) -> &Domain;
    async fn snapshot(&self) -> Result<Snapshot>;
    async fn heartbeat(&mut self, epoch: u64) -> Result<()>;
    async fn commit(&mut self, checkpoint: &SignedCheckpoint) -> Result<()>;
    async fn report_crash(&mut self) -> Result<()>;
    async fn recover(&mut self, epoch: u64, digest: &str, backup_key: &str) -> Result<()>;
    async fn payment(&self, id: &str) -> Result<Option<Payment>>;
    async fn reserve(&mut self, id: &str, effect: &Effect, epoch: u64) -> Result<()>;
    async fn settle(&mut self, id: &str, epoch: u64) -> Result<()>;
}
/// Separate signer/service. It must re-read chain policy and independently verify
/// checkpoint signatures, domain, epoch and effect. The coordinator cannot grant
/// itself either permission. Fence the vault BEFORE granting PHOENIX recovery.
pub trait Verifier {
    async fn authorize_recovery(
        &mut self,
        checkpoint: &SignedCheckpoint,
        backup_key: &str,
    ) -> Result<()>;
    async fn authorize_payment(
        &mut self,
        checkpoint: &SignedCheckpoint,
        session: &Session,
        effect: &Effect,
    ) -> Result<()>;
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HeartbeatBody {
    pub domain: Domain,
    pub worker_key: String,
    pub epoch: u64,
    pub sequence: u64,
    pub issued_at: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Heartbeat {
    pub body: HeartbeatBody,
    pub signature: String,
}
impl Heartbeat {
    pub fn sign(body: HeartbeatBody, key: &SigningKey) -> Result<Self> {
        ensure!(
            worker_key(key) == body.worker_key,
            "Heartbeat signer mismatch"
        );
        Ok(Self {
            signature: hex(&key.sign(&pulse_bytes(&body)?).to_bytes()),
            body,
        })
    }
    pub fn verify(&self, plan: &Plan, snapshot: &Snapshot, epoch: u64, key: &str) -> Result<()> {
        ensure!(
            self.body.domain == plan.domain
                && self.body.epoch == epoch
                && self.body.worker_key == key,
            "Heartbeat fence mismatch"
        );
        ensure!(
            plan.worker_keys.contains(&self.body.worker_key),
            "Unregistered heartbeat signer"
        );
        ensure!(
            self.body.sequence > 0 && self.body.issued_at <= snapshot.now,
            "Invalid heartbeat time/sequence"
        );
        ensure!(
            snapshot.now - self.body.issued_at < snapshot.timeout_ns.min(5_000_000_000),
            "Stale heartbeat"
        );
        let public_key = VerifyingKey::from_bytes(&unhex::<32>(&self.body.worker_key)?)?;
        public_key.verify_strict(
            &pulse_bytes(&self.body)?,
            &Signature::from_bytes(&unhex::<64>(&self.signature)?),
        )?;
        Ok(())
    }
}
fn pulse_bytes(body: &HeartbeatBody) -> Result<Vec<u8>> {
    let mut bytes = b"NEAR_PHOENIX_HEARTBEAT_V1\0".to_vec();
    bytes.extend(serde_json::to_vec(body)?);
    Ok(bytes)
}
#[derive(Clone, Debug)]
pub struct Session {
    pub epoch: u64,
    pub worker_key: String,
    pub checkpoint_digest: String,
}
#[derive(Clone, Debug)]
pub struct Restoration {
    pub session: Session,
    pub checkpoint: SignedCheckpoint,
}
#[derive(Clone, Debug)]
pub enum Tick {
    Healthy,
    NoBackup,
    Restore(Box<Restoration>),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PaymentOutcome {
    Paid,
    AlreadyPaid,
    Waiting,
    Terminal,
}

pub fn verify_anchor(
    checkpoint: &SignedCheckpoint,
    plan: &Plan,
    snapshot: &Snapshot,
) -> Result<()> {
    checkpoint.verify(plan, snapshot.now)?;
    let head = snapshot
        .head
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No anchored checkpoint"))?;
    ensure!(
        checkpoint.digest()? == head.digest
            && checkpoint.body.sequence == head.sequence
            && checkpoint.body.epoch == head.epoch
            && checkpoint.body.expires_at == head.expires_at,
        "Checkpoint anchor mismatch"
    );
    ensure!(
        head.epoch == snapshot.epoch || head.epoch.checked_add(1) == Some(snapshot.epoch),
        "Stale checkpoint epoch"
    );
    if head.epoch == snapshot.epoch {
        ensure!(
            checkpoint.body.worker_key == snapshot.worker_key,
            "Wrong active checkpoint signer"
        );
    }
    Ok(())
}
/// A single local coordinator owns the durable store lease for its lifetime.
/// Contract epochs additionally fence stale sessions at the payment boundary.
pub struct Coordinator {
    pub plan: Plan,
    pub store: CheckpointStore,
    _lease: Lease,
    last_pulse: Option<(u64, String, u64)>,
}
impl Coordinator {
    pub fn new(plan: Plan, store: CheckpointStore) -> Result<Self> {
        plan.validate()?;
        let lease = store.lease(&plan.domain)?;
        Ok(Self {
            plan,
            store,
            _lease: lease,
            last_pulse: None,
        })
    }
    pub async fn heartbeat<C: Chain>(&mut self, chain: &mut C, pulse: &Heartbeat) -> Result<()> {
        ensure!(
            chain.domain() == &self.plan.domain,
            "Chain adapter domain mismatch"
        );
        let snapshot = chain.snapshot().await?;
        self.running(&snapshot)?;
        pulse.verify(&self.plan, &snapshot, snapshot.epoch, &snapshot.worker_key)?;
        ensure!(
            pulse.body.issued_at >= snapshot.heartbeat_at,
            "Heartbeat already consumed on chain"
        );
        if let Some((epoch, key, sequence)) = &self.last_pulse {
            ensure!(
                *epoch != pulse.body.epoch
                    || key != &pulse.body.worker_key
                    || *sequence < pulse.body.sequence,
                "Heartbeat replay"
            );
        }
        chain.heartbeat(snapshot.epoch).await?;
        self.last_pulse = Some((
            pulse.body.epoch,
            pulse.body.worker_key.clone(),
            pulse.body.sequence,
        ));
        Ok(())
    }
    pub async fn save<C: Chain>(
        &self,
        chain: &mut C,
        checkpoint: &SignedCheckpoint,
    ) -> Result<Session> {
        ensure!(
            chain.domain() == &self.plan.domain,
            "Chain adapter domain mismatch"
        );
        let snapshot = chain.snapshot().await?;
        self.running(&snapshot)?;
        checkpoint.verify(&self.plan, snapshot.now)?;
        ensure!(
            checkpoint.body.epoch == snapshot.epoch
                && checkpoint.body.worker_key == snapshot.worker_key,
            "Checkpoint fence mismatch"
        );
        let sequence = snapshot
            .head
            .as_ref()
            .map_or(Some(1), |head| head.sequence.checked_add(1))
            .ok_or_else(|| anyhow::anyhow!("Sequence overflow"))?;
        ensure!(
            checkpoint.body.sequence == sequence
                && checkpoint.body.previous_digest
                    == snapshot.head.as_ref().map(|head| head.digest.clone()),
            "Checkpoint rollback or lineage mismatch"
        );
        if let Some(head) = &snapshot.head {
            let parent = self.store.load(&head.digest)?;
            ensure!(
                checkpoint.body.state.completed_steps >= parent.body.state.completed_steps,
                "Task progress rollback"
            );
        }
        // An interrupted chain commit leaves only an orphan blob. The chain head
        // stays authoritative and a retry never trusts that orphan as committed.
        let id = self.store.put(checkpoint)?;
        chain.commit(checkpoint).await?;
        let current = chain.snapshot().await?;
        verify_anchor(checkpoint, &self.plan, &current)?;
        self.running(&current)?;
        ensure!(
            current.epoch == snapshot.epoch && current.worker_key == snapshot.worker_key,
            "Fence changed during checkpoint commit"
        );
        Ok(Session {
            epoch: current.epoch,
            worker_key: current.worker_key,
            checkpoint_digest: id,
        })
    }
    pub async fn tick<C: Chain, V: Verifier>(
        &self,
        chain: &mut C,
        verifier: &mut V,
        ready: &[Heartbeat],
    ) -> Result<Tick> {
        ensure!(
            chain.domain() == &self.plan.domain,
            "Chain adapter domain mismatch"
        );
        let mut snapshot = chain.snapshot().await?;
        ensure!(
            !snapshot.paused && snapshot.status != AgentStatus::Contained,
            "Recovery contained or paused"
        );
        // A coordinator restart after a successful recover can reconstruct the
        // restoration from the chain head without consuming a second grant.
        if snapshot.status == AgentStatus::Running {
            if let Some(head) = &snapshot.head
                && head.epoch.checked_add(1) == Some(snapshot.epoch)
                && snapshot.now.saturating_sub(snapshot.heartbeat_at) < snapshot.timeout_ns
            {
                return Ok(Tick::Restore(Box::new(self.restoration(&snapshot)?)));
            }
            if snapshot.now.saturating_sub(snapshot.heartbeat_at) < snapshot.timeout_ns {
                return Ok(Tick::Healthy);
            }
            chain.report_crash().await?;
            snapshot = chain.snapshot().await?;
        }
        ensure!(snapshot.status == AgentStatus::Crashed, "Agent not crashed");
        let checkpoint = self.store.load(
            &snapshot
                .head
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("No recoverable checkpoint"))?
                .digest,
        )?;
        verify_anchor(&checkpoint, &self.plan, &snapshot)?;
        ensure!(
            checkpoint.body.epoch == snapshot.epoch,
            "No checkpoint for crashed epoch"
        );
        let next_epoch = snapshot
            .epoch
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("Epoch overflow"))?;
        // Selection is deterministic in the owner-configured order; a candidate
        // must prove possession of its registered key with a fresh signed pulse.
        let Some(backup) = snapshot.backups.iter().find(|key| {
            ready
                .iter()
                .any(|pulse| pulse.verify(&self.plan, &snapshot, next_epoch, key).is_ok())
        }) else {
            return Ok(Tick::NoBackup);
        };
        verifier.authorize_recovery(&checkpoint, backup).await?;
        chain
            .recover(snapshot.epoch, &checkpoint.digest()?, backup)
            .await?;
        let recovered = chain.snapshot().await?;
        self.running(&recovered)?;
        ensure!(
            recovered.epoch == next_epoch && &recovered.worker_key == backup,
            "Recovery fence mismatch"
        );
        Ok(Tick::Restore(Box::new(self.restoration(&recovered)?)))
    }
    fn restoration(&self, snapshot: &Snapshot) -> Result<Restoration> {
        let head = snapshot
            .head
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("No restoration head"))?;
        let checkpoint = self.store.load(&head.digest)?;
        verify_anchor(&checkpoint, &self.plan, snapshot)?;
        Ok(Restoration {
            session: Session {
                epoch: snapshot.epoch,
                worker_key: snapshot.worker_key.clone(),
                checkpoint_digest: head.digest.clone(),
            },
            checkpoint,
        })
    }
    fn running(&self, snapshot: &Snapshot) -> Result<()> {
        ensure!(
            self.plan.worker_keys.contains(&snapshot.worker_key),
            "Unregistered active worker"
        );
        ensure!(
            !snapshot.paused && snapshot.status == AgentStatus::Running,
            "Agent not active"
        );
        ensure!(
            snapshot.now.saturating_sub(snapshot.heartbeat_at) < snapshot.timeout_ns,
            "Agent heartbeat expired"
        );
        Ok(())
    }
    async fn fenced<C: Chain>(
        &self,
        chain: &C,
        session: &Session,
        checkpoint: &SignedCheckpoint,
    ) -> Result<()> {
        ensure!(
            chain.domain() == &self.plan.domain,
            "Chain adapter domain mismatch"
        );
        let snapshot = chain.snapshot().await?;
        self.running(&snapshot)?;
        ensure!(
            session.epoch == snapshot.epoch
                && session.worker_key == snapshot.worker_key
                && session.checkpoint_digest == checkpoint.digest()?,
            "Stale execution fence"
        );
        verify_anchor(checkpoint, &self.plan, &snapshot)
    }
    pub async fn execute_payments<C: Chain, V: Verifier>(
        &self,
        chain: &mut C,
        verifier: &mut V,
        session: &Session,
        checkpoint: &SignedCheckpoint,
    ) -> Result<Vec<PaymentOutcome>> {
        ensure!(
            chain.domain() == &self.plan.domain,
            "Chain adapter domain mismatch"
        );
        self.fenced(chain, session, checkpoint).await?;
        let mut outcomes = Vec::new();
        for name in &checkpoint.body.state.requested_effects {
            let effect = self
                .plan
                .effects
                .iter()
                .find(|e| &e.name == name)
                .ok_or_else(|| anyhow::anyhow!("Unplanned payment"))?;
            let id = self.plan.payment_id(effect)?;
            self.fenced(chain, session, checkpoint).await?;
            if chain.payment(&id).await?.is_none() {
                chain.reserve(&id, effect, session.epoch).await?;
            }
            let payment = chain
                .payment(&id)
                .await?
                .ok_or_else(|| anyhow::anyhow!("Reservation not observable"))?;
            ensure!(
                payment.task_id == self.plan.domain.task_id
                    && payment.recipient == effect.recipient
                    && payment.amount == effect.amount
                    && payment.commitment == id,
                "Payment intent mismatch"
            );
            match payment.state {
                PaymentState::Succeeded => outcomes.push(PaymentOutcome::AlreadyPaid),
                PaymentState::Pending | PaymentState::Uncertain => {
                    outcomes.push(PaymentOutcome::Waiting)
                }
                PaymentState::Failed | PaymentState::Cancelled => {
                    outcomes.push(PaymentOutcome::Terminal)
                }
                PaymentState::Reserved => {
                    self.fenced(chain, session, checkpoint).await?;
                    verifier
                        .authorize_payment(checkpoint, session, effect)
                        .await?;
                    self.fenced(chain, session, checkpoint).await?;
                    chain.settle(&id, session.epoch).await?;
                    let final_state = chain
                        .payment(&id)
                        .await?
                        .ok_or_else(|| anyhow::anyhow!("Payment outcome unavailable"))?;
                    outcomes.push(match final_state.state {
                        PaymentState::Succeeded => PaymentOutcome::Paid,
                        PaymentState::Failed | PaymentState::Cancelled => PaymentOutcome::Terminal,
                        _ => PaymentOutcome::Waiting,
                    });
                }
            }
        }
        Ok(outcomes)
    }
}
/// A worker host must make restore idempotent for (deployment, agent, epoch).
/// It receives data and an epoch capability, never NEAR signing credentials.
pub trait WorkerHost {
    /// Return None when the active process is dead/unresponsive. Never synthesize
    /// liveness from the coordinator process itself.
    async fn active_heartbeat(&mut self) -> Result<Option<Heartbeat>> {
        Ok(None)
    }
    async fn ready(&mut self) -> Result<Vec<Heartbeat>>;
    async fn restore(&mut self, restoration: Restoration) -> Result<()>;
}
/// Automatic polling loop. Errors fail closed and are surfaced to its supervisor;
/// a living coordinator never fabricates worker heartbeats.
pub async fn monitor<C: Chain, V: Verifier, W: WorkerHost>(
    coordinator: &mut Coordinator,
    chain: &mut C,
    verifier: &mut V,
    workers: &mut W,
    interval: Duration,
    mut stop: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    ensure!(!interval.is_zero(), "Positive monitor interval required");
    loop {
        if *stop.borrow() {
            return Ok(());
        }
        let snapshot = chain.snapshot().await?;
        if !snapshot.paused
            && snapshot.status == AgentStatus::Running
            && snapshot.now.saturating_sub(snapshot.heartbeat_at) < snapshot.timeout_ns
            && let Some(pulse) = workers.active_heartbeat().await?
        {
            coordinator.heartbeat(chain, &pulse).await?;
        }
        let ready = workers.ready().await?;
        if let Tick::Restore(restoration) = coordinator.tick(chain, verifier, &ready).await? {
            workers.restore(*restoration).await?;
        }
        tokio::select! {
            _ = tokio::time::sleep(interval) => {},
            result = stop.changed() => { if result.is_err() || *stop.borrow() { return Ok(()); } }
        }
    }
}
