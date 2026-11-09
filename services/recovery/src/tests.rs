use super::*;
use anyhow::{Result, ensure};
use ed25519_dalek::SigningKey;
use std::{
    cell::Cell,
    collections::HashMap,
    path::PathBuf,
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
            "phoenix-stateflow-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn plan() -> Plan {
    Plan {
        domain: Domain {
            network: "sandbox".into(),
            deployment: "unique-run".into(),
            core_id: "core.test".into(),
            vault_id: "vault.test".into(),
            agent_id: "agent.test".into(),
            task_id: "task".into(),
            execution_id: "execution".into(),
            code_digest: "ab".repeat(32),
            policy_digest: "cd".repeat(32),
        },
        worker_keys: vec![
            worker_key(&SigningKey::from_bytes(&[1; 32])),
            worker_key(&SigningKey::from_bytes(&[2; 32])),
            worker_key(&SigningKey::from_bytes(&[3; 32])),
        ],
        effects: vec![Effect {
            name: "invoice".into(),
            recipient: "recipient.test".into(),
            amount: "100".into(),
        }],
    }
}
fn checkpoint(plan: &Plan) -> SignedCheckpoint {
    SignedCheckpoint::sign(
        CheckpointBody {
            domain: plan.domain.clone(),
            plan_digest: digest(&serde_json::to_vec(plan).unwrap()),
            epoch: 0,
            sequence: 1,
            previous_digest: None,
            worker_key: plan.worker_keys[0].clone(),
            issued_at: 100,
            expires_at: 10_000,
            state: TaskState {
                completed_steps: 1,
                result: "computed".into(),
                requested_effects: vec!["invoice".into()],
            },
        },
        &SigningKey::from_bytes(&[1; 32]),
    )
    .unwrap()
}
fn snapshot(plan: &Plan) -> Snapshot {
    Snapshot {
        now: 100,
        paused: false,
        status: AgentStatus::Running,
        epoch: 0,
        heartbeat_at: 100,
        timeout_ns: 1000,
        worker_key: plan.worker_keys[0].clone(),
        backups: vec![plan.worker_keys[1].clone(), plan.worker_keys[2].clone()],
        head: None,
    }
}
struct MockChain {
    snapshot: Snapshot,
    payments: HashMap<String, Payment>,
    reserves: usize,
    sends: usize,
    grant: Rc<Cell<bool>>,
    vault_epoch: Rc<Cell<u64>>,
    plan: Plan,
}
impl Chain for MockChain {
    fn domain(&self) -> &Domain {
        &self.plan.domain
    }
    async fn snapshot(&self) -> Result<Snapshot> {
        Ok(self.snapshot.clone())
    }
    async fn heartbeat(&mut self, epoch: u64) -> Result<()> {
        ensure!(epoch == self.snapshot.epoch, "Stale epoch");
        self.snapshot.heartbeat_at = self.snapshot.now;
        Ok(())
    }
    async fn commit(&mut self, cp: &SignedCheckpoint) -> Result<()> {
        self.snapshot.head = Some(Head {
            digest: cp.digest()?,
            epoch: cp.body.epoch,
            sequence: cp.body.sequence,
            expires_at: cp.body.expires_at,
        });
        Ok(())
    }
    async fn report_crash(&mut self) -> Result<()> {
        self.snapshot.status = AgentStatus::Crashed;
        Ok(())
    }
    async fn recover(&mut self, epoch: u64, _: &str, backup: &str) -> Result<()> {
        ensure!(self.grant.replace(false), "No independent grant");
        ensure!(epoch == self.snapshot.epoch, "Stale epoch");
        ensure!(
            self.snapshot.backups.iter().any(|key| key == backup),
            "Backup not authorized"
        );
        self.snapshot.epoch += 1;
        self.snapshot.worker_key = backup.into();
        self.snapshot.backups.retain(|k| k != backup);
        self.snapshot.status = AgentStatus::Running;
        self.snapshot.heartbeat_at = self.snapshot.now;
        Ok(())
    }
    async fn payment(&self, id: &str) -> Result<Option<Payment>> {
        Ok(self.payments.get(id).cloned())
    }
    async fn reserve(&mut self, id: &str, effect: &Effect, epoch: u64) -> Result<()> {
        ensure!(epoch == self.vault_epoch.get(), "Stale vault epoch");
        ensure!(!self.payments.contains_key(id), "Duplicate ID");
        self.reserves += 1;
        self.payments.insert(
            id.into(),
            Payment {
                task_id: self.plan.domain.task_id.clone(),
                recipient: effect.recipient.clone(),
                amount: effect.amount.clone(),
                commitment: id.into(),
                epoch: Some(epoch),
                approved: false,
                state: PaymentState::Reserved,
            },
        );
        Ok(())
    }
    async fn settle(&mut self, id: &str, epoch: u64) -> Result<()> {
        ensure!(epoch == self.vault_epoch.get(), "Stale vault epoch");
        ensure!(self.grant.replace(false), "No payment approval");
        let payment = self.payments.get_mut(id).unwrap();
        ensure!(
            payment.state == PaymentState::Reserved,
            "Duplicate settlement"
        );
        payment.state = PaymentState::Succeeded;
        self.sends += 1;
        Ok(())
    }
}
struct MockVerifier {
    allow: bool,
    grant: Rc<Cell<bool>>,
    vault_epoch: Rc<Cell<u64>>,
}
impl Verifier for MockVerifier {
    async fn authorize_recovery(&mut self, cp: &SignedCheckpoint, _: &str) -> Result<()> {
        ensure!(self.allow, "Sentinel refused");
        self.vault_epoch.set(cp.body.epoch + 1);
        self.grant.set(true);
        Ok(())
    }
    async fn authorize_payment(
        &mut self,
        _: &SignedCheckpoint,
        _: &Session,
        _: &Effect,
    ) -> Result<()> {
        ensure!(self.allow, "Verifier refused");
        self.grant.set(true);
        Ok(())
    }
}
struct Fixture {
    coordinator: Coordinator,
    chain: MockChain,
    verifier: MockVerifier,
    cp: SignedCheckpoint,
    _temp: Temp,
}
impl Fixture {
    async fn new() -> Self {
        let plan = plan();
        let cp = checkpoint(&plan);
        let temp = Temp::new();
        let coordinator =
            Coordinator::new(plan.clone(), CheckpointStore::open(&temp.0).unwrap()).unwrap();
        let grant = Rc::new(Cell::new(false));
        let vault_epoch = Rc::new(Cell::new(0));
        let mut chain = MockChain {
            snapshot: snapshot(&plan),
            payments: HashMap::new(),
            reserves: 0,
            sends: 0,
            grant: grant.clone(),
            vault_epoch: vault_epoch.clone(),
            plan,
        };
        coordinator.save(&mut chain, &cp).await.unwrap();
        Self {
            coordinator,
            chain,
            verifier: MockVerifier {
                allow: true,
                grant,
                vault_epoch,
            },
            cp,
            _temp: temp,
        }
    }
    fn session(&self) -> Session {
        Session {
            epoch: 0,
            worker_key: self.cp.body.worker_key.clone(),
            checkpoint_digest: self.cp.digest().unwrap(),
        }
    }
    fn ready(&self) -> Heartbeat {
        self.ready_as(2)
    }
    fn ready_as(&self, seed: u8) -> Heartbeat {
        Heartbeat::sign(
            HeartbeatBody {
                domain: self.coordinator.plan.domain.clone(),
                worker_key: worker_key(&SigningKey::from_bytes(&[seed; 32])),
                epoch: 1,
                sequence: 1,
                issued_at: self.chain.snapshot.now,
            },
            &SigningKey::from_bytes(&[seed; 32]),
        )
        .unwrap()
    }
}
#[test]
fn strict_signature_domain_and_expiry_verified() {
    let p = plan();
    let cp = checkpoint(&p);
    cp.verify(&p, 100).unwrap();
    assert!(cp.verify(&p, 10_000).is_err());
    let mut other = p.clone();
    other.domain.deployment = "other".into();
    assert!(cp.verify(&other, 100).is_err());
}
#[test]
fn payload_tampering_rejected() {
    let p = plan();
    let mut cp = checkpoint(&p);
    cp.body.state.result = "forged".into();
    assert!(cp.verify(&p, 100).is_err());
}
#[test]
fn registered_key_cannot_substitute_for_original_signer() {
    let p = plan();
    let mut cp = checkpoint(&p);
    cp.body.worker_key = p.worker_keys[1].clone();
    assert!(cp.verify(&p, 100).is_err());
}
#[test]
fn plan_mutation_invalidates_checkpoint() {
    let p = plan();
    let cp = checkpoint(&p);
    let mut changed = p;
    changed.effects[0].amount = "101".into();
    assert!(cp.verify(&changed, 100).is_err());
}
#[test]
fn public_networks_are_rejected() {
    let mut p = plan();
    p.domain.network = "mainnet".into();
    assert!(p.validate().is_err());
}
#[test]
fn payment_id_survives_recovery_and_changes_with_domain() {
    let p = plan();
    let before = p.payment_id(&p.effects[0]).unwrap();
    let mut cp = checkpoint(&p);
    cp.body.epoch = 9;
    assert_eq!(before, p.payment_id(&p.effects[0]).unwrap());
    let mut p2 = p.clone();
    p2.domain.deployment = "new-run".into();
    assert_ne!(before, p2.payment_id(&p2.effects[0]).unwrap());
}
#[test]
fn store_is_idempotent_and_detects_tampering() {
    let temp = Temp::new();
    let store = CheckpointStore::open(&temp.0).unwrap();
    let cp = checkpoint(&plan());
    let id = store.put(&cp).unwrap();
    assert_eq!(id, store.put(&cp).unwrap());
    assert_eq!(store.load(&id).unwrap().digest().unwrap(), id);
    std::fs::write(temp.0.join(format!("{id}.json")), b"{}").unwrap();
    assert!(store.load(&id).is_err());
    assert!(store.load("../secrets").is_err());
}
#[test]
fn lease_cannot_be_stolen_by_timeout() {
    let temp = Temp::new();
    let store = CheckpointStore::open(&temp.0).unwrap();
    let first = store.lease(&plan().domain).unwrap();
    assert!(store.lease(&plan().domain).is_err());
    drop(first);
    assert!(store.lease(&plan().domain).is_ok());
}
#[tokio::test]
async fn automatic_detection_selects_signed_backup_and_restores_data() {
    let mut f = Fixture::new().await;
    f.chain.snapshot.now = 1100;
    let ready = f.ready();
    let Tick::Restore(restored) = f
        .coordinator
        .tick(&mut f.chain, &mut f.verifier, &[ready])
        .await
        .unwrap()
    else {
        panic!("No restore")
    };
    assert_eq!(restored.session.epoch, 1);
    assert_eq!(restored.checkpoint.body.state.result, "computed");
    assert_eq!(f.chain.vault_epoch.get(), 1);
}
#[tokio::test]
async fn healthy_primary_does_not_trigger_recovery() {
    let mut f = Fixture::new().await;
    assert!(matches!(
        f.coordinator
            .tick(&mut f.chain, &mut f.verifier, &[])
            .await
            .unwrap(),
        Tick::Healthy
    ));
}
#[tokio::test]
async fn absent_backup_stays_crashed_without_grant() {
    let mut f = Fixture::new().await;
    f.chain.snapshot.now = 1100;
    assert!(matches!(
        f.coordinator
            .tick(&mut f.chain, &mut f.verifier, &[])
            .await
            .unwrap(),
        Tick::NoBackup
    ));
    assert_eq!(f.chain.snapshot.epoch, 0);
    assert!(!f.chain.grant.get());
}
#[tokio::test]
async fn unsigned_or_wrong_epoch_backup_not_selected() {
    let mut f = Fixture::new().await;
    f.chain.snapshot.now = 1100;
    let mut ready = f.ready();
    ready.body.epoch = 0;
    assert!(matches!(
        f.coordinator
            .tick(&mut f.chain, &mut f.verifier, &[ready])
            .await
            .unwrap(),
        Tick::NoBackup
    ));
}
#[tokio::test]
async fn mesh_selection_uses_configured_order_not_pulse_arrival_order() {
    let mut f = Fixture::new().await;
    f.chain.snapshot.now = 1100;
    // Arrive in reverse order; the chain-configured backup order remains authoritative.
    let later = f.ready_as(3);
    let first = f.ready_as(2);
    let Tick::Restore(restored) = f
        .coordinator
        .tick(&mut f.chain, &mut f.verifier, &[later, first])
        .await
        .unwrap()
    else {
        panic!("No restore")
    };
    assert_eq!(
        restored.session.worker_key,
        f.coordinator.plan.worker_keys[1]
    );
    assert_eq!(f.chain.snapshot.epoch, 1);
}
#[tokio::test]
async fn mesh_fails_over_when_preferred_backup_has_failed() {
    let mut f = Fixture::new().await;
    f.chain.snapshot.now = 1100;
    // The preferred backup is absent because its heartbeat worker failed; the next
    // configured candidate can be selected only with its own fresh signed pulse.
    let secondary = f.ready_as(3);
    let Tick::Restore(restored) = f
        .coordinator
        .tick(&mut f.chain, &mut f.verifier, &[secondary])
        .await
        .unwrap()
    else {
        panic!("No restore")
    };
    assert_eq!(
        restored.session.worker_key,
        f.coordinator.plan.worker_keys[2]
    );
    assert_eq!(f.chain.snapshot.epoch, 1);
}
#[tokio::test]
async fn unregistered_mesh_candidate_and_replayed_pulse_are_rejected() {
    let mut f = Fixture::new().await;
    f.chain.snapshot.now = 1100;
    let rogue = Heartbeat::sign(
        HeartbeatBody {
            domain: f.coordinator.plan.domain.clone(),
            worker_key: worker_key(&SigningKey::from_bytes(&[9; 32])),
            epoch: 1,
            sequence: 1,
            issued_at: 1100,
        },
        &SigningKey::from_bytes(&[9; 32]),
    )
    .unwrap();
    assert!(matches!(
        f.coordinator
            .tick(&mut f.chain, &mut f.verifier, &[rogue])
            .await
            .unwrap(),
        Tick::NoBackup
    ));
    assert_eq!(f.chain.snapshot.epoch, 0);
}
#[tokio::test]
async fn independent_recovery_refusal_fails_closed() {
    let mut f = Fixture::new().await;
    f.chain.snapshot.now = 1100;
    f.verifier.allow = false;
    let ready = f.ready();
    assert!(
        f.coordinator
            .tick(&mut f.chain, &mut f.verifier, &[ready])
            .await
            .is_err()
    );
    assert_eq!(f.chain.snapshot.epoch, 0);
}
#[tokio::test]
async fn expired_or_missing_checkpoint_cannot_restore() {
    let mut f = Fixture::new().await;
    f.chain.snapshot.now = 10_000;
    let ready = f.ready();
    assert!(
        f.coordinator
            .tick(&mut f.chain, &mut f.verifier, &[ready])
            .await
            .is_err()
    );
    assert_eq!(f.chain.snapshot.epoch, 0);
}
#[tokio::test]
async fn checkpoint_replay_and_progress_rollback_fail() {
    let mut f = Fixture::new().await;
    assert!(f.coordinator.save(&mut f.chain, &f.cp).await.is_err());
    let mut body = f.cp.body.clone();
    body.sequence = 2;
    body.previous_digest = Some(f.cp.digest().unwrap());
    body.state.completed_steps = 0;
    let cp = SignedCheckpoint::sign(body, &SigningKey::from_bytes(&[1; 32])).unwrap();
    assert!(f.coordinator.save(&mut f.chain, &cp).await.is_err());
}
#[tokio::test]
async fn heartbeat_requires_live_current_signer_and_monotonic_sequence() {
    let mut f = Fixture::new().await;
    let pulse = Heartbeat::sign(
        HeartbeatBody {
            domain: f.coordinator.plan.domain.clone(),
            worker_key: f.cp.body.worker_key.clone(),
            epoch: 0,
            sequence: 1,
            issued_at: 100,
        },
        &SigningKey::from_bytes(&[1; 32]),
    )
    .unwrap();
    f.coordinator.heartbeat(&mut f.chain, &pulse).await.unwrap();
    assert!(f.coordinator.heartbeat(&mut f.chain, &pulse).await.is_err());
    let mut fake = pulse;
    fake.body.epoch = 1;
    assert!(f.coordinator.heartbeat(&mut f.chain, &fake).await.is_err());
}
#[tokio::test]
async fn recovered_checkpoint_cannot_duplicate_payment_after_lost_ack() {
    let mut f = Fixture::new().await;
    let old = f.session();
    assert_eq!(
        f.coordinator
            .execute_payments(&mut f.chain, &mut f.verifier, &old, &f.cp)
            .await
            .unwrap(),
        vec![PaymentOutcome::Paid]
    );
    f.chain.snapshot.now = 1100;
    let ready = f.ready();
    let Tick::Restore(restored) = f
        .coordinator
        .tick(&mut f.chain, &mut f.verifier, &[ready])
        .await
        .unwrap()
    else {
        panic!()
    };
    assert!(
        f.coordinator
            .execute_payments(&mut f.chain, &mut f.verifier, &old, &f.cp)
            .await
            .is_err()
    );
    assert_eq!(
        f.coordinator
            .execute_payments(
                &mut f.chain,
                &mut f.verifier,
                &restored.session,
                &restored.checkpoint
            )
            .await
            .unwrap(),
        vec![PaymentOutcome::AlreadyPaid]
    );
    assert_eq!(f.chain.sends, 1);
    assert_eq!(f.chain.reserves, 1);
}
#[tokio::test]
async fn pending_uncertain_and_terminal_payments_are_never_retried() {
    for state in [
        PaymentState::Pending,
        PaymentState::Uncertain,
        PaymentState::Failed,
        PaymentState::Cancelled,
    ] {
        let mut f = Fixture::new().await;
        let id = f
            .coordinator
            .plan
            .payment_id(&f.coordinator.plan.effects[0])
            .unwrap();
        f.chain
            .reserve(&id, &f.coordinator.plan.effects[0], 0)
            .await
            .unwrap();
        f.chain.payments.get_mut(&id).unwrap().state = state.clone();
        let session = f.session();
        let result = f
            .coordinator
            .execute_payments(&mut f.chain, &mut f.verifier, &session, &f.cp)
            .await
            .unwrap();
        assert_eq!(
            result,
            vec![
                if matches!(state, PaymentState::Pending | PaymentState::Uncertain) {
                    PaymentOutcome::Waiting
                } else {
                    PaymentOutcome::Terminal
                }
            ]
        );
        assert_eq!(f.chain.sends, 0);
    }
}
#[tokio::test]
async fn payment_identity_mismatch_blocks_dispatch() {
    let mut f = Fixture::new().await;
    let id = f
        .coordinator
        .plan
        .payment_id(&f.coordinator.plan.effects[0])
        .unwrap();
    f.chain
        .reserve(&id, &f.coordinator.plan.effects[0], 0)
        .await
        .unwrap();
    f.chain.payments.get_mut(&id).unwrap().recipient = "attacker.test".into();
    let session = f.session();
    assert!(
        f.coordinator
            .execute_payments(&mut f.chain, &mut f.verifier, &session, &f.cp)
            .await
            .is_err()
    );
    assert_eq!(f.chain.sends, 0);
}
#[tokio::test]
async fn containment_stops_restoration_and_payments() {
    let mut f = Fixture::new().await;
    f.chain.snapshot.status = AgentStatus::Contained;
    let session = f.session();
    assert!(
        f.coordinator
            .tick(&mut f.chain, &mut f.verifier, &[])
            .await
            .is_err()
    );
    assert!(
        f.coordinator
            .execute_payments(&mut f.chain, &mut f.verifier, &session, &f.cp)
            .await
            .is_err()
    );
}
#[tokio::test]
async fn restart_after_recover_reconstructs_same_session_without_second_epoch() {
    let mut f = Fixture::new().await;
    f.chain.snapshot.now = 1100;
    let ready = f.ready();
    f.coordinator
        .tick(&mut f.chain, &mut f.verifier, &[ready])
        .await
        .unwrap();
    let Tick::Restore(restored) = f
        .coordinator
        .tick(&mut f.chain, &mut f.verifier, &[])
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(restored.session.epoch, 1);
    assert_eq!(f.chain.snapshot.epoch, 1);
}

struct TestHost {
    pulse: Option<Heartbeat>,
    ready: Vec<Heartbeat>,
    restored: usize,
    stop: tokio::sync::watch::Sender<bool>,
    stop_on_ready: bool,
}
impl WorkerHost for TestHost {
    async fn active_heartbeat(&mut self) -> Result<Option<Heartbeat>> {
        Ok(self.pulse.take())
    }
    async fn ready(&mut self) -> Result<Vec<Heartbeat>> {
        if self.stop_on_ready {
            self.stop.send(true)?;
        }
        Ok(self.ready.clone())
    }
    async fn restore(&mut self, restored: Restoration) -> Result<()> {
        assert_eq!(restored.session.epoch, 1);
        self.restored += 1;
        self.stop.send(true)?;
        Ok(())
    }
}
#[tokio::test]
async fn polling_monitor_automatically_restores_dead_primary_and_stops() {
    let mut f = Fixture::new().await;
    f.chain.snapshot.now = 1100;
    let ready = f.ready();
    let (send, receive) = tokio::sync::watch::channel(false);
    let mut host = TestHost {
        pulse: None,
        ready: vec![ready],
        restored: 0,
        stop: send,
        stop_on_ready: false,
    };
    monitor(
        &mut f.coordinator,
        &mut f.chain,
        &mut f.verifier,
        &mut host,
        std::time::Duration::from_millis(1),
        receive,
    )
    .await
    .unwrap();
    assert_eq!(host.restored, 1);
    assert_eq!(f.chain.snapshot.epoch, 1);
}
#[tokio::test]
async fn polling_monitor_forwards_signed_worker_liveness_without_fabrication() {
    let mut f = Fixture::new().await;
    f.chain.snapshot.now = 200;
    let pulse = Heartbeat::sign(
        HeartbeatBody {
            domain: f.coordinator.plan.domain.clone(),
            worker_key: f.cp.body.worker_key.clone(),
            epoch: 0,
            sequence: 1,
            issued_at: 200,
        },
        &SigningKey::from_bytes(&[1; 32]),
    )
    .unwrap();
    let (send, receive) = tokio::sync::watch::channel(false);
    let mut host = TestHost {
        pulse: Some(pulse),
        ready: vec![],
        restored: 0,
        stop: send,
        stop_on_ready: true,
    };
    monitor(
        &mut f.coordinator,
        &mut f.chain,
        &mut f.verifier,
        &mut host,
        std::time::Duration::from_millis(1),
        receive,
    )
    .await
    .unwrap();
    assert_eq!(f.chain.snapshot.heartbeat_at, 200);
    assert_eq!(host.restored, 0);
}

#[tokio::test]
async fn wrong_adapter_domain_cannot_trigger_chain_mutations() {
    let mut f = Fixture::new().await;
    f.chain.plan.domain.deployment = "different-sandbox".into();
    let session = f.session();
    assert!(f.coordinator.save(&mut f.chain, &f.cp).await.is_err());
    assert!(
        f.coordinator
            .tick(&mut f.chain, &mut f.verifier, &[])
            .await
            .is_err()
    );
    assert!(
        f.coordinator
            .execute_payments(&mut f.chain, &mut f.verifier, &session, &f.cp)
            .await
            .is_err()
    );
    assert_eq!(f.chain.reserves, 0);
    assert_eq!(f.chain.sends, 0);
}
