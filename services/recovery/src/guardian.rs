//! Scoped monitoring and signed hash-chain audit. A risk signal can only stop work.
use crate::*;
use anyhow::{Result, ensure};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub enum SecurityEventKind {
    AuthorizationFailure,
    ApprovalRejected {
        approval_id: String,
        reason: ApprovalFailureReason,
    },
    TransferObserved {
        operation_id: String,
        recipient: String,
        amount: String,
    },
    ReplayAttempt {
        replayed_evidence_id: String,
        target: String,
    },
    CompromisedAgent {
        worker_key: String,
        worker_epoch: u64,
        evidence_digest: String,
    },
    UnexpectedRecovery {
        worker_key: String,
        observed_epoch: u64,
        evidence_digest: String,
        reason: RecoveryAnomaly,
    },
    WorkerActivity {
        worker_key: String,
        worker_epoch: u64,
        actions: u64,
    },
    RiskSignal {
        score: u8,
    },
    RecoveryCompleted,
}
/// Closed enumerations keep untrusted text out of policy decisions and logs.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub enum ApprovalFailureReason {
    Unauthorized,
    Expired,
    Replay,
    ScopeMismatch,
    Malformed,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub enum RecoveryAnomaly {
    UnauthorizedBackup,
    StaleEpoch,
    MissingCheckpoint,
    MissingReceipt,
    ConflictingWorker,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SecurityEventBody {
    pub domain: Domain,
    pub source_key: String,
    pub source_nonce: u64,
    pub evidence_id: String,
    pub epoch: u64,
    pub issued_at: u64,
    pub kind: SecurityEventKind,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SecurityEvent {
    pub body: SecurityEventBody,
    pub signature: String,
}
impl SecurityEvent {
    pub fn sign(body: SecurityEventBody, key: &SigningKey) -> Result<Self> {
        ensure!(body.source_key == worker_key(key), "Event source mismatch");
        Ok(Self {
            signature: hex(&key
                .sign(&prefixed(b"PHOENIX_GUARDIAN_EVENT_V1\0", &body)?)
                .to_bytes()),
            body,
        })
    }
    pub fn verify(&self, policy: &GuardianPolicy, domain: &Domain, now: u64) -> Result<()> {
        ensure!(
            &self.body.domain == domain && policy.observer_keys.contains(&self.body.source_key),
            "Untrusted security event"
        );
        ensure!(
            self.body.source_nonce > 0
                && self.body.issued_at <= now
                && now - self.body.issued_at <= policy.max_event_age_ns,
            "Stale security event"
        );
        unhex::<32>(&self.body.evidence_id)?;
        let key = VerifyingKey::from_bytes(&unhex::<32>(&self.body.source_key)?)?;
        key.verify_strict(
            &prefixed(b"PHOENIX_GUARDIAN_EVENT_V1\0", &self.body)?,
            &Signature::from_bytes(&unhex::<64>(&self.signature)?),
        )?;
        Ok(())
    }
}
#[derive(Clone, Debug)]
pub struct GuardianPolicy {
    pub observer_keys: Vec<String>,
    pub failures_threshold: usize,
    pub max_payments_per_window: usize,
    pub window_ns: u64,
    pub max_events_per_window: usize,
    pub max_worker_actions: u64,
    pub risk_quarantine_threshold: u8,
    pub max_event_age_ns: u64,
}
impl GuardianPolicy {
    fn validate(&self, plan: &Plan, auditor: &str) -> Result<()> {
        ensure!(
            !self.observer_keys.is_empty()
                && self.failures_threshold > 0
                && self.max_payments_per_window > 0
                && self.window_ns > 0
                && self.max_events_per_window > 0
                && self.max_worker_actions > 0
                && self.max_event_age_ns > 0
                && self.risk_quarantine_threshold <= 100,
            "Invalid guardian thresholds"
        );
        ensure!(
            !plan.worker_keys.contains(&auditor.to_owned()),
            "AI worker cannot be audit authority"
        );
        for (i, key) in self.observer_keys.iter().enumerate() {
            ensure!(
                !plan.worker_keys.contains(key) && !self.observer_keys[..i].contains(key),
                "Untrusted observer identity"
            );
            ensure!(
                !VerifyingKey::from_bytes(&unhex::<32>(key)?)?.is_weak(),
                "Weak observer key"
            );
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum Decision {
    Observe,
    Quarantine { reason: String },
    RecoveryAcknowledged,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuditBody {
    pub domain: Domain,
    pub sequence: u64,
    pub previous_digest: Option<String>,
    pub event: SecurityEvent,
    pub decision: Decision,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuditRecord {
    pub body: AuditBody,
    pub signature: String,
}
impl AuditRecord {
    pub fn digest(&self) -> Result<String> {
        Ok(digest(&serde_json::to_vec(self)?))
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditHead {
    pub sequence: u64,
    pub digest: String,
}
fn prefixed<T: Serialize>(prefix: &[u8], body: &T) -> Result<Vec<u8>> {
    let mut bytes = prefix.to_vec();
    bytes.extend(serde_json::to_vec(body)?);
    ensure!(
        bytes.len() <= MAX_CHECKPOINT_BYTES,
        "Security record too large"
    );
    Ok(bytes)
}

/// Signed append-only records; the PHOENIX anchor detects deletion, rewrite and
/// truncation. One unanchored tail record is a recoverable write-ahead intent.
pub struct AuditLog {
    root: PathBuf,
    key: SigningKey,
    records: Vec<AuditRecord>,
    _lease: Lease,
}
impl AuditLog {
    pub fn open(root: impl AsRef<Path>, domain: &Domain, key: SigningKey) -> Result<Self> {
        let store = CheckpointStore::open(root.as_ref())?;
        let lease = store.lease(domain)?;
        let mut paths = Vec::new();
        for entry in fs::read_dir(root.as_ref())? {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                paths.push(path);
            }
        }
        paths.sort();
        let mut records: Vec<AuditRecord> = Vec::new();
        for (i, path) in paths.iter().enumerate() {
            ensure!(
                path.file_name().and_then(|f| f.to_str()) == Some(&format!("{:020}.json", i + 1)),
                "Audit sequence gap"
            );
            let mut bytes = Vec::new();
            fs::File::open(path)?
                .take((MAX_CHECKPOINT_BYTES + 1) as u64)
                .read_to_end(&mut bytes)?;
            ensure!(
                bytes.len() <= MAX_CHECKPOINT_BYTES,
                "Audit record too large"
            );
            let record: AuditRecord = serde_json::from_slice(&bytes)?;
            ensure!(
                &record.body.domain == domain
                    && record.body.sequence == (i + 1) as u64
                    && record.body.previous_digest
                        == records.last().map(|r| r.digest()).transpose()?,
                "Audit lineage mismatch"
            );
            key.verifying_key().verify_strict(
                &prefixed(b"PHOENIX_GUARDIAN_AUDIT_V1\0", &record.body)?,
                &Signature::from_bytes(&unhex::<64>(&record.signature)?),
            )?;
            records.push(record);
        }
        Ok(Self {
            root: root.as_ref().into(),
            key,
            records,
            _lease: lease,
        })
    }
    pub fn head(&self) -> Result<Option<AuditHead>> {
        self.records
            .last()
            .map(|record| {
                Ok(AuditHead {
                    sequence: record.body.sequence,
                    digest: record.digest()?,
                })
            })
            .transpose()
    }
    fn append(&mut self, event: SecurityEvent, decision: Decision) -> Result<AuditRecord> {
        let body = AuditBody {
            domain: event.body.domain.clone(),
            sequence: (self.records.len() as u64)
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("Audit overflow"))?,
            previous_digest: self.head()?.map(|h| h.digest),
            event,
            decision,
        };
        let record = AuditRecord {
            signature: hex(&self
                .key
                .sign(&prefixed(b"PHOENIX_GUARDIAN_AUDIT_V1\0", &body)?)
                .to_bytes()),
            body,
        };
        let name = format!("{:020}.json", record.body.sequence);
        let temp = self.root.join(format!(".{name}.tmp"));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        let outcome = (|| -> Result<()> {
            file.write_all(&serde_json::to_vec(&record)?)?;
            file.sync_all()?;
            fs::hard_link(&temp, self.root.join(name))?;
            fs::File::open(&self.root)?.sync_all()?;
            Ok(())
        })();
        let cleanup = fs::remove_file(temp);
        outcome?;
        cleanup?;
        self.records.push(record.clone());
        Ok(record)
    }
}
#[derive(Clone, Default)]
struct Detector {
    nonces: BTreeMap<String, u64>,
    evidence: BTreeSet<String>,
    recent: Vec<(u64, bool, bool)>,
    observed_operations: BTreeSet<String>,
    quarantined_epoch: Option<u64>,
}
impl Detector {
    fn observe(
        &mut self,
        event: &SecurityEvent,
        plan: &Plan,
        policy: &GuardianPolicy,
    ) -> Result<Decision> {
        let b = &event.body;
        ensure!(
            self.nonces.get(&b.source_key).copied().unwrap_or(0) < b.source_nonce,
            "Security event nonce replay"
        );
        ensure!(
            !self.evidence.contains(&b.evidence_id),
            "Security evidence replay"
        );
        self.nonces.insert(b.source_key.clone(), b.source_nonce);
        self.evidence.insert(b.evidence_id.clone());
        if b.kind == SecurityEventKind::RecoveryCompleted {
            ensure!(
                self.quarantined_epoch.is_some_and(|epoch| b.epoch > epoch),
                "Recovery must advance quarantined epoch"
            );
            self.quarantined_epoch = None;
            self.recent.clear();
            return Ok(Decision::RecoveryAcknowledged);
        }
        self.recent
            .retain(|(time, _, _)| b.issued_at.saturating_sub(*time) <= policy.window_ns);
        let auth_failure = matches!(
            &b.kind,
            SecurityEventKind::AuthorizationFailure | SecurityEventKind::ApprovalRejected { .. }
        );
        let payment = matches!(&b.kind, SecurityEventKind::TransferObserved { .. });
        self.recent.push((b.issued_at, auth_failure, payment));
        let mut reason = if self.recent.len() > policy.max_events_per_window {
            Some("Abnormal event rate")
        } else {
            None
        };
        if self.recent.iter().filter(|(_, failed, _)| *failed).count() >= policy.failures_threshold
        {
            reason = Some("Repeated authorization failures");
        }
        if self
            .recent
            .iter()
            .filter(|(_, _, payment)| *payment)
            .count()
            > policy.max_payments_per_window
        {
            reason = Some("Abnormal payment frequency");
        }
        match &b.kind {
            SecurityEventKind::ApprovalRejected { approval_id, .. } => {
                unhex::<32>(approval_id)?;
            }
            SecurityEventKind::TransferObserved {
                operation_id,
                recipient,
                amount,
            } => {
                let duplicate = !self.observed_operations.insert(operation_id.clone());
                let expected = plan.effects.iter().any(|e| {
                    e.recipient == *recipient
                        && e.amount == *amount
                        && plan.payment_id(e).is_ok_and(|id| id == *operation_id)
                });
                if duplicate {
                    reason = Some("Duplicate settlement observation");
                } else if !expected {
                    reason = Some("Suspicious settlement intent");
                }
            }
            SecurityEventKind::ReplayAttempt {
                replayed_evidence_id,
                target,
            } => {
                unhex::<32>(replayed_evidence_id)?;
                ensure!(
                    !target.is_empty() && target.len() <= 128,
                    "Invalid replay target"
                );
                reason = Some("Replay attempt observed");
            }
            SecurityEventKind::CompromisedAgent {
                worker_key,
                worker_epoch,
                evidence_digest,
            } => {
                unhex::<32>(worker_key)?;
                unhex::<32>(evidence_digest)?;
                ensure!(*worker_epoch == b.epoch, "Stale compromised-agent signal");
                reason = Some("Compromised agent signal");
            }
            SecurityEventKind::UnexpectedRecovery {
                worker_key,
                observed_epoch,
                evidence_digest,
                ..
            } => {
                unhex::<32>(worker_key)?;
                unhex::<32>(evidence_digest)?;
                ensure!(
                    *observed_epoch == b.epoch,
                    "Stale unexpected-recovery signal"
                );
                reason = Some("Unexpected recovery observed");
            }
            SecurityEventKind::WorkerActivity {
                worker_key,
                worker_epoch,
                actions,
            } => {
                if !plan.worker_keys.contains(worker_key)
                    || *worker_epoch != b.epoch
                    || *actions > policy.max_worker_actions
                {
                    reason = Some("Abnormal worker behavior");
                }
            }
            SecurityEventKind::RiskSignal { score } => {
                ensure!(*score <= 100, "Invalid risk signal");
                if *score >= policy.risk_quarantine_threshold {
                    reason = Some("Advisory risk quarantine; no spending authority");
                }
            }
            _ => {}
        }
        if let Some(reason) = reason {
            self.quarantined_epoch = Some(b.epoch);
            Ok(Decision::Quarantine {
                reason: reason.into(),
            })
        } else {
            Ok(Decision::Observe)
        }
    }
}
#[derive(Clone, Debug)]
pub struct SecurityState {
    pub epoch: u64,
    pub running: bool,
    pub task_paused: bool,
    pub task_epoch: u64,
}
pub trait SecurityChain {
    fn domain(&self) -> &Domain;
    async fn security_state(&self) -> Result<SecurityState>;
    async fn now(&self) -> Result<u64>;
    async fn audit_head(&self) -> Result<Option<AuditHead>>;
    async fn anchor(&mut self, record: &AuditRecord) -> Result<()>;
    async fn quarantine(&mut self, reason: &str) -> Result<()>;
}
pub struct Guardian {
    plan: Plan,
    policy: GuardianPolicy,
    log: AuditLog,
    detector: Detector,
}
impl Guardian {
    pub fn new(plan: Plan, policy: GuardianPolicy, log: AuditLog) -> Result<Self> {
        plan.validate()?;
        policy.validate(&plan, &worker_key(&log.key))?;
        let mut detector = Detector::default();
        for record in &log.records {
            record
                .body
                .event
                .verify(&policy, &plan.domain, record.body.event.body.issued_at)?;
            let decision = detector.observe(&record.body.event, &plan, &policy)?;
            ensure!(decision == record.body.decision, "Audit decision mismatch");
        }
        Ok(Self {
            plan,
            policy,
            log,
            detector,
        })
    }
    async fn apply<C: SecurityChain>(chain: &mut C, record: &AuditRecord) -> Result<()> {
        match &record.body.decision {
            Decision::Quarantine { reason } => {
                ensure!(
                    chain.security_state().await?.epoch == record.body.event.body.epoch,
                    "Stale pending quarantine"
                );
                chain.quarantine(reason).await?;
            }
            Decision::RecoveryAcknowledged => {
                let state = chain.security_state().await?;
                ensure!(
                    state.running
                        && !state.task_paused
                        && state.epoch == record.body.event.body.epoch
                        && state.task_epoch == state.epoch,
                    "Recovery not independently completed on chain"
                );
            }
            Decision::Observe => {}
        }
        chain.anchor(record).await
    }
    /// Reconcile a partially applied stop/anchor before accepting another event.
    pub async fn synchronize<C: SecurityChain>(&mut self, chain: &mut C) -> Result<()> {
        ensure!(
            chain.domain() == &self.plan.domain,
            "Guardian chain domain mismatch"
        );
        let remote = chain.audit_head().await?;
        let count = remote.as_ref().map_or(0, |h| h.sequence);
        ensure!(
            count <= self.log.records.len() as u64 && (self.log.records.len() as u64) - count <= 1,
            "Audit truncation or unanchored history"
        );
        if let Some(head) = remote {
            ensure!(
                count > 0 && self.log.records[(count - 1) as usize].digest()? == head.digest,
                "Audit anchor mismatch"
            );
        }
        if count < self.log.records.len() as u64 {
            Self::apply(chain, &self.log.records[count as usize]).await?;
        }
        Ok(())
    }
    pub async fn handle<C: SecurityChain>(
        &mut self,
        chain: &mut C,
        event: SecurityEvent,
    ) -> Result<Decision> {
        self.synchronize(chain).await?;
        event.verify(&self.policy, &self.plan.domain, chain.now().await?)?;
        let state = chain.security_state().await?;
        ensure!(
            event.body.epoch == state.epoch,
            "Stale security event epoch"
        );
        let mut next = self.detector.clone();
        let decision = next.observe(&event, &self.plan, &self.policy)?;
        if decision == Decision::RecoveryAcknowledged {
            ensure!(
                state.running && !state.task_paused && state.task_epoch == state.epoch,
                "Recovery not independently completed on chain"
            );
        }
        let record = self.log.append(event, decision.clone())?;
        self.detector = next;
        Self::apply(chain, &record).await?;
        Ok(decision)
    }
    pub fn audit_head(&self) -> Result<Option<AuditHead>> {
        self.log.head()
    }
}
pub trait SecurityEventSource {
    async fn next_event(&mut self) -> Result<Option<SecurityEvent>>;
}
/// Authenticated event sources must derive receipts from finalized RPC or trusted
/// worker supervision, never accept unsigned agent claims as security evidence.
pub async fn monitor_security<C: SecurityChain, S: SecurityEventSource>(
    guardian: &mut Guardian,
    chain: &mut C,
    source: &mut S,
    interval: Duration,
    mut stop: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    ensure!(
        !interval.is_zero(),
        "Positive security polling interval required"
    );
    loop {
        if *stop.borrow() {
            return Ok(());
        }
        if let Some(event) = source.next_event().await? {
            guardian.handle(chain, event).await?;
        }
        tokio::select! {_ = tokio::time::sleep(interval)=>{}, result=stop.changed()=>{if result.is_err()||*stop.borrow(){return Ok(())}}}
    }
}
