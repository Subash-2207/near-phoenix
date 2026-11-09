use near_sdk::json_types::U64;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, PanicOnDefault};
use phoenix_security_types::{
    decode_hex, Action, ApprovalPolicy, SignedApproval, SignedRecoveryReceipt,
};

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Running,
    Crashed,
    Contained,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Agent {
    pub operator: AccountId,
    pub sentinel: AccountId,
    pub heartbeat_at: U64,
    pub timeout_ns: U64,
    pub generation: U64,
    pub status: Status,
    pub recovery_approved: bool,
}

/// A STATEFLOW commitment anchored by the coordinator after signature verification.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct CheckpointHead {
    pub generation: U64,
    pub sequence: U64,
    pub digest: String,
    pub expires_at: U64,
}
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct RecoveryGrant {
    pub generation: U64,
    pub digest: String,
    pub backup_key: String,
    pub expires_at: U64,
}
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Stateflow {
    pub task_id: String,
    pub worker_key: String,
    pub backup_keys: Vec<String>,
    pub head: Option<CheckpointHead>,
    pub grant: Option<RecoveryGrant>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct SecurityAuditHead {
    pub sequence: U64,
    pub digest: String,
}

/// Recovery facts written by Core at the epoch transition. The optional signed
/// attestation is added only after SENTINEL verifies the referenced REWIND outcome.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct ProofOfRecovery {
    pub task_id: String,
    pub primary_identity: String,
    pub backup_identity: String,
    pub checkpoint_hash: String,
    pub epoch_from: U64,
    pub epoch_to: U64,
    pub security_revision: U64,
    pub recovered_at: U64,
    pub verified_by: Option<AccountId>,
    pub verified_at: Option<U64>,
    pub signed_receipt: Option<SignedRecoveryReceipt>,
}

/// Recovery authorization registry. Does not execute agents or move funds.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PhoenixCore {
    owner: AccountId,
    guardian: AccountId,
    paused: bool,
    agents: LookupMap<AccountId, Agent>,
    flows: LookupMap<AccountId, Stateflow>,
    sentinel_policies: LookupMap<AccountId, ApprovalPolicy>,
    audits: LookupMap<AccountId, SecurityAuditHead>,
    security_revisions: LookupMap<AccountId, u64>,
    recovery_receipts: LookupMap<(AccountId, u64), ProofOfRecovery>,
}

#[near]
impl PhoenixCore {
    #[init]
    pub fn new(owner: AccountId, guardian: AccountId) -> Self {
        Self {
            owner,
            guardian,
            paused: false,
            agents: LookupMap::new(b"a"),
            flows: LookupMap::new(b"f"),
            sentinel_policies: LookupMap::new(b"s"),
            audits: LookupMap::new(b"q"),
            security_revisions: LookupMap::new(b"r"),
            recovery_receipts: LookupMap::new(b"p"),
        }
    }

    /// Owner provisions storage from the contract's balance. Registration is not public.
    pub fn register_agent(
        &mut self,
        agent_id: AccountId,
        operator: AccountId,
        sentinel: AccountId,
        timeout_ns: U64,
    ) {
        self.assert_owner();
        self.assert_active();
        assert_ne!(operator, sentinel, "Sentinel must be independent");
        assert!(
            (1_000_000_000..=86_400_000_000_000).contains(&timeout_ns.0),
            "Timeout must be 1s to 24h"
        );
        assert!(!self.agents.contains_key(&agent_id), "Agent exists");
        self.agents.insert(
            agent_id,
            Agent {
                operator,
                sentinel,
                heartbeat_at: U64(env::block_timestamp()),
                timeout_ns,
                generation: U64(0),
                status: Status::Running,
                recovery_approved: false,
            },
        );
    }

    /// Epoch binds heartbeats to the current incarnation and rejects delayed messages.
    pub fn heartbeat(&mut self, agent_id: AccountId, generation: U64) {
        self.assert_active();
        let mut a = self.agent(&agent_id);
        assert_eq!(env::predecessor_account_id(), a.operator, "Operator only");
        assert_eq!(generation, a.generation, "Stale generation");
        assert_eq!(a.status, Status::Running, "Agent not running");
        assert!(!Self::expired(&a), "Heartbeat expired; recovery required");
        a.heartbeat_at = U64(env::block_timestamp());
        self.agents.insert(agent_id, a);
    }

    /// Permissionless detection, based exclusively on chain time.
    pub fn report_crash(&mut self, agent_id: AccountId) {
        self.assert_active();
        let mut a = self.agent(&agent_id);
        assert_eq!(a.status, Status::Running, "Agent not running");
        assert!(Self::expired(&a), "Heartbeat not expired");
        a.status = Status::Crashed;
        a.recovery_approved = false;
        if let Some(flow) = self.flows.get_mut(&agent_id) {
            flow.grant = None;
        }
        self.agents.insert(agent_id, a);
    }

    pub fn approve_recovery(&mut self, agent_id: AccountId, generation: U64) {
        assert!(
            !self.flows.contains_key(&agent_id),
            "Checkpoint recovery required"
        );
        self.assert_active();
        let mut a = self.agent(&agent_id);
        assert_eq!(env::predecessor_account_id(), a.sentinel, "Sentinel only");
        assert_eq!(generation, a.generation, "Stale generation");
        assert_eq!(a.status, Status::Crashed, "Agent not crashed");
        assert!(!a.recovery_approved, "Already approved");
        a.recovery_approved = true;
        self.agents.insert(agent_id, a);
    }

    pub fn recover(&mut self, agent_id: AccountId, generation: U64) {
        assert!(
            !self.flows.contains_key(&agent_id),
            "Checkpoint recovery required"
        );
        self.assert_active();
        let mut a = self.agent(&agent_id);
        assert_eq!(env::predecessor_account_id(), a.operator, "Operator only");
        assert_eq!(generation, a.generation, "Stale generation");
        assert_eq!(a.status, Status::Crashed, "Agent not crashed");
        assert!(a.recovery_approved, "Independent approval required");
        a.generation = U64(a.generation.0.checked_add(1).expect("Generation overflow"));
        a.heartbeat_at = U64(env::block_timestamp());
        a.status = Status::Running;
        a.recovery_approved = false;
        if let Some(flow) = self.flows.get_mut(&agent_id) {
            flow.grant = None;
        }
        self.agents.insert(agent_id, a);
    }

    /// Containment works during a global pause and invalidates pending approval.
    pub fn contain(&mut self, agent_id: AccountId) {
        let caller = env::predecessor_account_id();
        assert!(
            caller == self.owner || caller == self.guardian,
            "Guardian or owner only"
        );
        let mut a = self.agent(&agent_id);
        if a.status != Status::Contained {
            let revision = self
                .get_security_revision(agent_id.clone())
                .0
                .checked_add(1)
                .expect("Revision overflow");
            self.security_revisions.insert(agent_id.clone(), revision);
        }
        a.status = Status::Contained;
        a.recovery_approved = false;
        if let Some(flow) = self.flows.get_mut(&agent_id) {
            flow.grant = None;
        }
        self.agents.insert(agent_id, a);
    }

    /// Owner explicitly reopens verification; it cannot directly resume execution.
    pub fn reopen_contained(&mut self, agent_id: AccountId) {
        self.assert_owner();
        self.assert_active();
        let mut a = self.agent(&agent_id);
        assert_eq!(a.status, Status::Contained, "Agent not contained");
        a.status = Status::Crashed;
        a.recovery_approved = false;
        if let Some(flow) = self.flows.get_mut(&agent_id) {
            flow.grant = None;
        }
        self.agents.insert(agent_id, a);
    }

    /// Opt-in policy; worker keys never receive NEAR executor or verifier keys.
    /// Owner funds bounded policy/checkpoint storage, as for agent registration.
    pub fn configure_stateflow(
        &mut self,
        agent_id: AccountId,
        task_id: String,
        worker_key: String,
        backup_keys: Vec<String>,
    ) {
        self.assert_owner();
        self.assert_active();
        let a = self.agent(&agent_id);
        assert_eq!(a.status, Status::Running, "Agent not running");
        assert_eq!(a.generation.0, 0, "Configure before recovery");
        assert!(!self.flows.contains_key(&agent_id), "Policy immutable");
        assert!(!a.recovery_approved, "Recovery already approved");
        assert!(
            !task_id.is_empty() && task_id.len() <= 64,
            "Invalid task ID"
        );
        valid_digest(&worker_key);
        assert!(
            !backup_keys.is_empty() && backup_keys.len() <= 8,
            "Use 1 to 8 backups"
        );
        for (i, key) in backup_keys.iter().enumerate() {
            valid_digest(key);
            assert!(
                key != &worker_key && !backup_keys[..i].contains(key),
                "Duplicate worker"
            );
        }
        self.flows.insert(
            agent_id,
            Stateflow {
                task_id,
                worker_key,
                backup_keys,
                head: None,
                grant: None,
            },
        );
    }

    pub fn commit_checkpoint(
        &mut self,
        agent_id: AccountId,
        generation: U64,
        sequence: U64,
        digest: String,
        previous_digest: Option<String>,
        expires_at: U64,
    ) {
        self.assert_active();
        let a = self.agent(&agent_id);
        assert_eq!(env::predecessor_account_id(), a.operator, "Operator only");
        assert_eq!(generation, a.generation, "Stale generation");
        assert_eq!(a.status, Status::Running, "Agent not running");
        assert!(!Self::expired(&a), "Heartbeat expired; recovery required");
        valid_digest(&digest);
        let now = env::block_timestamp();
        assert!(
            expires_at.0 > now && expires_at.0 - now <= 86_400_000_000_000,
            "Invalid checkpoint expiry"
        );
        let f = self
            .flows
            .get_mut(&agent_id)
            .expect("STATEFLOW not configured");
        let next = f.head.as_ref().map_or(1, |h| {
            h.sequence.0.checked_add(1).expect("Sequence overflow")
        });
        assert_eq!(sequence.0, next, "Checkpoint sequence mismatch");
        assert_eq!(
            previous_digest,
            f.head.as_ref().map(|h| h.digest.clone()),
            "Checkpoint lineage mismatch"
        );
        f.head = Some(CheckpointHead {
            generation,
            sequence,
            digest,
            expires_at,
        });
    }

    pub fn configure_sentinel(&mut self, agent_id: AccountId, policy: ApprovalPolicy) {
        self.assert_owner();
        self.assert_active();
        assert!(
            !self.sentinel_policies.contains_key(&agent_id),
            "Policy immutable"
        );
        policy.validate().expect("Invalid sentinel policy");
        let agent = self.agent(&agent_id);
        assert_eq!(
            policy.requester,
            agent.operator.as_str(),
            "Wrong policy operator"
        );
        assert_eq!(
            policy.verifier,
            agent.sentinel.as_str(),
            "Wrong policy sentinel"
        );
        assert_eq!(
            policy.domain.core_id,
            env::current_account_id().as_str(),
            "Wrong core domain"
        );
        assert_eq!(
            policy.domain.agent_id,
            agent_id.as_str(),
            "Wrong agent domain"
        );
        let f = self.flows.get(&agent_id).expect("STATEFLOW not configured");
        assert_eq!(f.task_id, policy.domain.task_id, "Wrong task domain");
        assert!(
            policy.worker_keys.contains(&f.worker_key)
                && f.backup_keys.iter().all(|k| policy.worker_keys.contains(k)),
            "Worker registry mismatch"
        );
        self.sentinel_policies.insert(agent_id, policy);
    }
    pub fn get_sentinel_policy(&self, agent_id: AccountId) -> Option<ApprovalPolicy> {
        self.sentinel_policies.get(&agent_id).cloned()
    }

    pub fn get_security_revision(&self, agent_id: AccountId) -> U64 {
        U64(*self.security_revisions.get(&agent_id).unwrap_or(&0))
    }

    /// Consume an explicit nonfinancial capability; this contract executes no external action.
    /// A downstream action host must reconcile this final authorization receipt exactly once.
    pub fn authorize_signed_action(&mut self, approval: SignedApproval) {
        self.assert_active();
        let body = &approval.body;
        assert!(
            matches!(body.action, Action::ExternalCall | Action::DataExport),
            "Use dedicated financial/recovery gate"
        );
        let agent_id: AccountId = body.domain.agent_id.parse().expect("Invalid agent ID");
        let a = self.agent(&agent_id);
        assert_eq!(env::predecessor_account_id(), a.sentinel, "Sentinel only");
        assert_eq!(a.status, Status::Running, "Agent not running");
        assert!(!Self::expired(&a), "Heartbeat expired");
        assert_eq!(body.epoch, a.generation.0, "Stale generation");
        assert_eq!(
            body.security_revision,
            self.get_security_revision(agent_id.clone()).0,
            "Stale security revision"
        );
        assert_eq!(
            body.requester,
            a.operator.as_str(),
            "Wrong approval requester"
        );
        let flow = self.flows.get(&agent_id).expect("STATEFLOW not configured");
        let head = flow.head.as_ref().expect("No checkpoint");
        assert_eq!(body.subject_key, flow.worker_key, "Wrong approval identity");
        assert_eq!(body.checkpoint_digest, head.digest, "Checkpoint mismatch");
        assert_eq!(
            body.epoch, head.generation.0,
            "Fresh current-epoch checkpoint required"
        );
        assert!(
            env::block_timestamp() < head.expires_at.0,
            "Checkpoint expired"
        );
        let mut policy = self
            .sentinel_policies
            .get(&agent_id)
            .expect("Sentinel not configured")
            .clone();
        policy
            .check(body, env::block_timestamp())
            .expect("Invalid signed approval");
        assert!(
            env::ed25519_verify(
                &decode_hex::<64>(&approval.signature).expect("Invalid signature"),
                body.signing_bytes(),
                &decode_hex::<32>(&policy.public_key).expect("Invalid public key")
            ),
            "Forged sentinel approval"
        );
        policy.last_nonce = body.nonce;
        self.sentinel_policies.insert(agent_id, policy);
        env::log_str(&format!(
            "SENTINEL_ACTION:{}:{}",
            body.nonce, body.operation_id
        ));
    }

    /// The hash chain is anchored per agent; sequence/previous hash cannot roll back.
    pub fn anchor_security_audit(
        &mut self,
        agent_id: AccountId,
        sequence: U64,
        digest: String,
        previous_digest: Option<String>,
    ) {
        let caller = env::predecessor_account_id();
        assert!(
            caller == self.guardian || caller == self.owner,
            "Guardian or owner only"
        );
        self.agent(&agent_id);
        valid_digest(&digest);
        let old = self.audits.get(&agent_id);
        assert_eq!(
            sequence.0,
            old.map_or(1, |h| h
                .sequence
                .0
                .checked_add(1)
                .expect("Audit sequence overflow")),
            "Audit sequence mismatch"
        );
        assert_eq!(
            previous_digest,
            old.map(|h| h.digest.clone()),
            "Audit predecessor mismatch"
        );
        self.audits
            .insert(agent_id, SecurityAuditHead { sequence, digest });
    }
    pub fn get_security_audit(&self, agent_id: AccountId) -> Option<SecurityAuditHead> {
        self.audits.get(&agent_id).cloned()
    }

    pub fn approve_signed_recovery(&mut self, approval: SignedApproval) {
        let body = &approval.body;
        let agent_id: AccountId = body.domain.agent_id.parse().expect("Invalid agent ID");
        let agent = self.agent(&agent_id);
        assert_eq!(
            env::predecessor_account_id(),
            agent.sentinel,
            "Sentinel only"
        );
        let mut policy = self
            .sentinel_policies
            .get(&agent_id)
            .expect("Sentinel not configured")
            .clone();
        policy
            .check(body, env::block_timestamp())
            .expect("Invalid signed approval");
        assert_eq!(body.action, Action::Recovery, "Wrong approval action");
        assert_eq!(
            body.security_revision,
            self.get_security_revision(agent_id.clone()).0,
            "Stale security revision"
        );
        assert_eq!(
            body.requester,
            agent.operator.as_str(),
            "Wrong approval requester"
        );
        assert_eq!(body.epoch, agent.generation.0, "Stale generation");
        let flow = self.flows.get(&agent_id).expect("STATEFLOW not configured");
        assert_eq!(body.subject_key, flow.worker_key, "Wrong approval identity");
        assert_eq!(
            body.operation_id, body.checkpoint_digest,
            "Recovery intent mismatch"
        );
        assert_eq!(
            body.commitment, body.checkpoint_digest,
            "Recovery commitment mismatch"
        );
        assert!(
            env::ed25519_verify(
                &decode_hex::<64>(&approval.signature).expect("Invalid signature"),
                body.signing_bytes(),
                &decode_hex::<32>(&policy.public_key).expect("Invalid public key")
            ),
            "Forged sentinel approval"
        );
        self.approve_checkpoint_recovery_inner(
            agent_id.clone(),
            U64(body.epoch),
            body.checkpoint_digest.clone(),
            body.recipient.clone(),
            Some(U64(body.expires_at)),
        );
        policy.last_nonce = body.nonce;
        self.sentinel_policies.insert(agent_id, policy);
    }

    /// Sentinel independently verifies the signed blob matching this exact chain head.
    pub fn approve_checkpoint_recovery(
        &mut self,
        agent_id: AccountId,
        generation: U64,
        digest: String,
        backup_key: String,
    ) {
        assert!(
            !self.sentinel_policies.contains_key(&agent_id),
            "Signed recovery approval required"
        );
        self.approve_checkpoint_recovery_inner(agent_id, generation, digest, backup_key, None);
    }
    fn approve_checkpoint_recovery_inner(
        &mut self,
        agent_id: AccountId,
        generation: U64,
        digest: String,
        backup_key: String,
        deadline: Option<U64>,
    ) {
        self.assert_active();
        let mut a = self.agent(&agent_id);
        assert_eq!(env::predecessor_account_id(), a.sentinel, "Sentinel only");
        assert_eq!(generation, a.generation, "Stale generation");
        assert_eq!(a.status, Status::Crashed, "Agent not crashed");
        assert!(!a.recovery_approved, "Already approved");
        let f = self
            .flows
            .get_mut(&agent_id)
            .expect("STATEFLOW not configured");
        let h = f.head.as_ref().expect("No checkpoint");
        assert_eq!(h.generation, generation, "Stale checkpoint epoch");
        assert_eq!(h.digest, digest, "Checkpoint mismatch");
        assert!(
            env::block_timestamp() < h.expires_at.0,
            "Checkpoint expired"
        );
        assert!(f.backup_keys.contains(&backup_key), "Backup not allowed");
        f.grant = Some(RecoveryGrant {
            generation,
            digest,
            backup_key,
            expires_at: U64(deadline.map_or(h.expires_at.0, |d| d.0.min(h.expires_at.0))),
        });
        a.recovery_approved = true;
        self.agents.insert(agent_id, a);
    }

    pub fn recover_checkpoint(
        &mut self,
        agent_id: AccountId,
        generation: U64,
        digest: String,
        backup_key: String,
    ) {
        self.assert_active();
        let mut a = self.agent(&agent_id);
        assert_eq!(env::predecessor_account_id(), a.operator, "Operator only");
        assert_eq!(generation, a.generation, "Stale generation");
        assert_eq!(a.status, Status::Crashed, "Agent not crashed");
        assert!(a.recovery_approved, "Independent approval required");
        let security_revision = U64(self.get_security_revision(agent_id.clone()).0);
        let f = self
            .flows
            .get_mut(&agent_id)
            .expect("STATEFLOW not configured");
        let h = f.head.as_ref().expect("No checkpoint");
        assert!(
            env::block_timestamp() < h.expires_at.0,
            "Checkpoint expired"
        );
        let grant = f.grant.as_ref().expect("No bound grant");
        assert!(
            env::block_timestamp() < grant.expires_at.0,
            "Recovery approval expired"
        );
        assert_eq!(grant.generation, generation, "Stale grant");
        assert_eq!(grant.digest, digest, "Checkpoint mismatch");
        assert_eq!(grant.backup_key, backup_key, "Backup mismatch");
        let epoch_to = a.generation.0.checked_add(1).expect("Generation overflow");
        let proof_key = (agent_id.clone(), epoch_to);
        assert!(
            self.recovery_receipts.get(&proof_key).is_none(),
            "Recovery receipt epoch already exists"
        );
        let proof = ProofOfRecovery {
            task_id: f.task_id.clone(),
            primary_identity: f.worker_key.clone(),
            backup_identity: backup_key.clone(),
            checkpoint_hash: digest.clone(),
            epoch_from: generation,
            epoch_to: U64(epoch_to),
            security_revision,
            recovered_at: U64(env::block_timestamp()),
            verified_by: None,
            verified_at: None,
            signed_receipt: None,
        };
        f.worker_key = backup_key.clone();
        f.backup_keys.retain(|key| key != &backup_key);
        f.grant = None;
        let task_id = proof.task_id.clone();
        a.generation = U64(epoch_to);
        a.heartbeat_at = U64(env::block_timestamp());
        a.status = Status::Running;
        a.recovery_approved = false;
        self.agents.insert(agent_id, a);
        self.recovery_receipts.insert(proof_key, proof);
        event("proof_recovery_started", &task_id);
    }

    /// Release an expired Sentinel recovery lease so a fresh, independently
    /// approved backup may be selected. This never activates an agent or changes
    /// its epoch; only the operator can consume a new grant via recover_checkpoint.
    pub fn expire_recovery_lease(&mut self, agent_id: AccountId) {
        let mut agent = self.agent(&agent_id);
        assert_eq!(agent.status, Status::Crashed, "Agent not crashed");
        assert!(agent.recovery_approved, "No recovery lease");
        let flow = self
            .flows
            .get_mut(&agent_id)
            .expect("STATEFLOW not configured");
        let grant = flow.grant.as_ref().expect("No recovery grant");
        assert!(
            env::block_timestamp() >= grant.expires_at.0,
            "Recovery lease still active"
        );
        flow.grant = None;
        agent.recovery_approved = false;
        self.agents.insert(agent_id, agent);
    }

    /// SENTINEL records a recovery proof only after independently confirming the
    /// exact REWIND payment operation succeeded on finalized local-chain state.
    /// Core verifies the attestation and its own immutable recovery transition;
    /// it cannot synchronously read REWIND state across contracts.
    pub fn record_recovery_receipt(&mut self, receipt: SignedRecoveryReceipt) {
        let body = &receipt.body;
        let agent_id: AccountId = body.domain.agent_id.parse().expect("Invalid agent ID");
        let agent = self.agent(&agent_id);
        assert_eq!(
            env::predecessor_account_id(),
            agent.sentinel,
            "Sentinel only"
        );
        body.validate_at(env::block_timestamp())
            .expect("Invalid recovery receipt");
        let proof_key = (agent_id.clone(), body.epoch_to);
        let mut proof = self
            .recovery_receipts
            .get(&proof_key)
            .expect("Recovery transition not found")
            .clone();
        assert!(proof.signed_receipt.is_none(), "Receipt already verified");
        assert_eq!(agent.generation.0, body.epoch_to, "Stale receipt epoch");
        assert_eq!(
            self.get_security_revision(agent_id.clone()).0,
            proof.security_revision.0,
            "Stale security revision"
        );
        assert_eq!(
            body.domain.agent_id,
            agent_id.as_str(),
            "Receipt agent mismatch"
        );
        assert_eq!(body.task_id, proof.task_id, "Receipt task mismatch");
        assert_eq!(
            body.primary_identity, proof.primary_identity,
            "Receipt primary identity mismatch"
        );
        assert_eq!(
            body.backup_identity, proof.backup_identity,
            "Receipt backup identity mismatch"
        );
        assert_eq!(
            body.checkpoint_hash, proof.checkpoint_hash,
            "Receipt checkpoint mismatch"
        );
        assert_eq!(
            body.epoch_from, proof.epoch_from.0,
            "Stale receipt source epoch"
        );
        assert_eq!(
            body.epoch_to, proof.epoch_to.0,
            "Stale receipt target epoch"
        );

        let mut policy = self
            .sentinel_policies
            .get(&agent_id)
            .expect("Sentinel not configured")
            .clone();
        assert_eq!(policy.domain, body.domain, "Receipt domain mismatch");
        assert_eq!(
            policy.last_nonce.checked_add(1),
            Some(body.nonce),
            "Recovery receipt replay or nonce mismatch"
        );
        assert!(
            env::ed25519_verify(
                &decode_hex::<64>(&receipt.signature).expect("Invalid receipt signature"),
                body.signing_bytes(),
                &decode_hex::<32>(&policy.public_key).expect("Invalid sentinel key")
            ),
            "Forged recovery receipt"
        );
        policy.last_nonce = body.nonce;
        proof.verified_by = Some(agent.sentinel.clone());
        proof.verified_at = Some(U64(env::block_timestamp()));
        proof.signed_receipt = Some(receipt);
        let task_id = proof.task_id.clone();
        self.sentinel_policies.insert(agent_id, policy);
        self.recovery_receipts.insert(proof_key, proof);
        event("proof_recovery_verified", &task_id);
    }

    /// Public read-only proof lookup by agent and destination recovery epoch.
    pub fn get_recovery_receipt(
        &self,
        agent_id: AccountId,
        epoch_to: U64,
    ) -> Option<ProofOfRecovery> {
        self.recovery_receipts.get(&(agent_id, epoch_to.0)).cloned()
    }

    pub fn get_stateflow(&self, agent_id: AccountId) -> Option<Stateflow> {
        self.flows.get(&agent_id).cloned()
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }
    pub fn get_agent(&self, agent_id: AccountId) -> Option<Agent> {
        self.agents.get(&agent_id).cloned()
    }
    pub fn is_paused(&self) -> bool {
        self.paused
    }
}

impl PhoenixCore {
    fn agent(&self, id: &AccountId) -> Agent {
        self.agents.get(id).expect("Unknown agent").clone()
    }
    fn expired(a: &Agent) -> bool {
        env::block_timestamp().saturating_sub(a.heartbeat_at.0) >= a.timeout_ns.0
    }
    fn assert_owner(&self) {
        assert_eq!(env::predecessor_account_id(), self.owner, "Owner only");
    }
    fn assert_active(&self) {
        assert!(!self.paused, "Contract paused");
    }
}

fn valid_digest(value: &str) {
    assert!(
        value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "Expected lowercase 32-byte hex"
    );
}

fn event(action: &str, task_id: &str) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        near_sdk::serde_json::json!({
            "standard": "phoenix",
            "version": "1.0.0",
            "event": action,
            "data": [{"task_id": task_id}]
        })
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::{test_utils::VMContextBuilder, testing_env};
    fn id(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn ctx(caller: &str, t: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(id("core.testnet"))
            .predecessor_account_id(id(caller))
            .block_timestamp(t)
            .build());
    }
    fn setup() -> PhoenixCore {
        ctx("owner.testnet", 0);
        let mut c = PhoenixCore::new(id("owner.testnet"), id("guardian.testnet"));
        c.register_agent(
            id("agent.testnet"),
            id("operator.testnet"),
            id("sentinel.testnet"),
            U64(1_000_000_000),
        );
        c
    }
    fn crash(c: &mut PhoenixCore) {
        ctx("anyone.testnet", 1_000_000_000);
        c.report_crash(id("agent.testnet"));
    }
    fn approve(c: &mut PhoenixCore) {
        ctx("sentinel.testnet", 1_000_000_000);
        c.approve_recovery(id("agent.testnet"), U64(0));
    }
    #[test]
    fn recovery_advances_epoch_and_consumes_approval() {
        let mut c = setup();
        crash(&mut c);
        approve(&mut c);
        ctx("operator.testnet", 1_000_000_001);
        c.recover(id("agent.testnet"), U64(0));
        let a = c.get_agent(id("agent.testnet")).unwrap();
        assert_eq!(a.status, Status::Running);
        assert_eq!(a.generation, U64(1));
        assert!(!a.recovery_approved);
    }
    #[test]
    fn valid_heartbeat_updates_time() {
        let mut c = setup();
        ctx("operator.testnet", 10);
        c.heartbeat(id("agent.testnet"), U64(0));
        assert_eq!(
            c.get_agent(id("agent.testnet")).unwrap().heartbeat_at,
            U64(10)
        );
    }
    #[test]
    #[should_panic(expected = "Owner only")]
    fn unauthorized_registration() {
        let mut c = setup();
        ctx("attacker.testnet", 0);
        c.register_agent(
            id("other.testnet"),
            id("operator.testnet"),
            id("sentinel.testnet"),
            U64(1_000_000_000),
        );
    }
    #[test]
    #[should_panic(expected = "Heartbeat not expired")]
    fn premature_crash() {
        let mut c = setup();
        c.report_crash(id("agent.testnet"));
    }
    #[test]
    #[should_panic(expected = "Heartbeat expired")]
    fn late_heartbeat() {
        let mut c = setup();
        ctx("operator.testnet", 1_000_000_000);
        c.heartbeat(id("agent.testnet"), U64(0));
    }
    #[test]
    #[should_panic(expected = "Operator only")]
    fn forged_heartbeat() {
        let mut c = setup();
        ctx("attacker.testnet", 1);
        c.heartbeat(id("agent.testnet"), U64(0));
    }
    #[test]
    #[should_panic(expected = "Independent approval required")]
    fn unapproved_recovery() {
        let mut c = setup();
        crash(&mut c);
        ctx("operator.testnet", 1_000_000_000);
        c.recover(id("agent.testnet"), U64(0));
    }
    #[test]
    #[should_panic(expected = "Sentinel only")]
    fn forged_approval() {
        let mut c = setup();
        crash(&mut c);
        ctx("operator.testnet", 1_000_000_000);
        c.approve_recovery(id("agent.testnet"), U64(0));
    }
    #[test]
    #[should_panic(expected = "Stale generation")]
    fn replayed_recovery() {
        let mut c = setup();
        crash(&mut c);
        approve(&mut c);
        ctx("operator.testnet", 1_000_000_000);
        c.recover(id("agent.testnet"), U64(0));
        c.recover(id("agent.testnet"), U64(0));
    }
    #[test]
    fn containment_during_pause_revokes_approval() {
        let mut c = setup();
        crash(&mut c);
        approve(&mut c);
        ctx("owner.testnet", 1_000_000_000);
        c.set_paused(true);
        ctx("guardian.testnet", 1_000_000_000);
        c.contain(id("agent.testnet"));
        let a = c.get_agent(id("agent.testnet")).unwrap();
        assert_eq!(a.status, Status::Contained);
        assert!(!a.recovery_approved);
    }
    #[test]
    #[should_panic(expected = "Contract paused")]
    fn paused_heartbeat() {
        let mut c = setup();
        c.set_paused(true);
        ctx("operator.testnet", 1);
        c.heartbeat(id("agent.testnet"), U64(0));
    }
    #[test]
    #[should_panic(expected = "Agent exists")]
    fn duplicate_registration() {
        let mut c = setup();
        c.register_agent(
            id("agent.testnet"),
            id("operator.testnet"),
            id("sentinel.testnet"),
            U64(1_000_000_000),
        );
    }
    #[test]
    #[should_panic(expected = "Sentinel must be independent")]
    fn self_verification() {
        let mut c = setup();
        c.register_agent(
            id("other.testnet"),
            id("operator.testnet"),
            id("operator.testnet"),
            U64(1_000_000_000),
        );
    }
    #[test]
    fn owner_reopening_requires_fresh_verification() {
        let mut c = setup();
        c.contain(id("agent.testnet"));
        c.reopen_contained(id("agent.testnet"));
        let a = c.get_agent(id("agent.testnet")).unwrap();
        assert_eq!(a.status, Status::Crashed);
        assert!(!a.recovery_approved);
    }
    #[test]
    #[should_panic(expected = "Guardian or owner only")]
    fn unauthorized_containment() {
        let mut c = setup();
        ctx("attacker.testnet", 0);
        c.contain(id("agent.testnet"));
    }
    #[test]
    fn unknown_agent_view() {
        let c = setup();
        assert!(c.get_agent(id("unknown.testnet")).is_none());
    }
}

#[cfg(test)]
mod phase3_tests;
#[cfg(test)]
mod phase4_tests;
