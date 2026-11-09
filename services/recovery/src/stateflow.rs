use anyhow::{Result, bail, ensure};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
const PREFIX: &[u8] = b"NEAR_PHOENIX_STATEFLOW_V1\0";
pub const MAX_CHECKPOINT_BYTES: usize = 1_048_576;

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn unhex<const N: usize>(value: &str) -> Result<[u8; N]> {
    ensure!(
        value.len() == N * 2
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "Invalid canonical hex"
    );
    let mut bytes = [0; N];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16)?;
    }
    Ok(bytes)
}
pub fn digest(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}
pub fn worker_key(key: &SigningKey) -> String {
    hex(key.verifying_key().as_bytes())
}

pub use phoenix_security_types::Domain;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Effect {
    pub name: String,
    pub recipient: String,
    pub amount: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    pub domain: Domain,
    pub worker_keys: Vec<String>,
    pub effects: Vec<Effect>,
}
impl Plan {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.domain.network == "sandbox",
            "Only local sandbox is supported"
        );
        ensure!(
            !self.domain.deployment.is_empty(),
            "Deployment domain required"
        );
        for value in [
            &self.domain.core_id,
            &self.domain.vault_id,
            &self.domain.agent_id,
            &self.domain.task_id,
            &self.domain.execution_id,
        ] {
            ensure!(
                !value.is_empty() && value.len() <= 64,
                "Invalid domain identifier"
            );
        }
        unhex::<32>(&self.domain.code_digest)?;
        unhex::<32>(&self.domain.policy_digest)?;
        ensure!(
            !self.worker_keys.is_empty() && self.worker_keys.len() <= 9,
            "Invalid worker registry"
        );
        for (i, key) in self.worker_keys.iter().enumerate() {
            let key_bytes = unhex::<32>(key)?;
            ensure!(
                !VerifyingKey::from_bytes(&key_bytes)?.is_weak(),
                "Weak worker key"
            );
            ensure!(!self.worker_keys[..i].contains(key), "Duplicate worker key");
        }
        ensure!(self.effects.len() <= 64, "Too many effects");
        for (i, effect) in self.effects.iter().enumerate() {
            ensure!(
                !effect.name.is_empty() && effect.name.len() <= 64 && !effect.recipient.is_empty(),
                "Invalid effect"
            );
            let amount = effect.amount.parse::<u128>()?;
            ensure!(
                amount > 0 && amount.to_string() == effect.amount,
                "Invalid amount"
            );
            ensure!(
                !self.effects[..i].iter().any(|e| e.name == effect.name),
                "Duplicate effect"
            );
        }
        Ok(())
    }
    /// Stable across checkpoints, workers and epochs. A recovery must never mint a new ID.
    pub fn payment_id(&self, effect: &Effect) -> Result<String> {
        ensure!(
            self.effects.contains(effect),
            "Effect outside immutable plan"
        );
        Ok(digest(&serde_json::to_vec(&(
            "PHOENIX_PAYMENT_V1",
            &self.domain,
            effect,
        ))?))
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TaskState {
    pub completed_steps: u64,
    /// Data only: never evaluated as commands, model instructions or credentials.
    pub result: String,
    pub requested_effects: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckpointBody {
    pub domain: Domain,
    /// Hash of the full pinned plan, including all allowed workers and effects.
    pub plan_digest: String,
    pub epoch: u64,
    pub sequence: u64,
    pub previous_digest: Option<String>,
    pub worker_key: String,
    pub issued_at: u64,
    pub expires_at: u64,
    pub state: TaskState,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignedCheckpoint {
    pub body: CheckpointBody,
    pub signature: String,
}
impl SignedCheckpoint {
    pub fn sign(body: CheckpointBody, key: &SigningKey) -> Result<Self> {
        ensure!(body.worker_key == worker_key(key), "Signer mismatch");
        let signature = hex(&key.sign(&signing_bytes(&body)?).to_bytes());
        Ok(Self { body, signature })
    }
    pub fn digest(&self) -> Result<String> {
        Ok(digest(&serde_json::to_vec(self)?))
    }
    pub fn verify(&self, plan: &Plan, now: u64) -> Result<()> {
        plan.validate()?;
        ensure!(
            self.body.domain == plan.domain,
            "Checkpoint domain mismatch"
        );
        ensure!(
            self.body.plan_digest == digest(&serde_json::to_vec(plan)?),
            "Checkpoint plan mismatch"
        );
        ensure!(
            plan.worker_keys.contains(&self.body.worker_key),
            "Unregistered signer"
        );
        ensure!(self.body.sequence > 0, "Invalid sequence");
        ensure!(
            self.body.issued_at <= now && now < self.body.expires_at,
            "Checkpoint expired or from future"
        );
        ensure!(
            self.body.expires_at - self.body.issued_at <= 86_400_000_000_000,
            "Checkpoint lifetime too long"
        );
        if let Some(previous) = &self.body.previous_digest {
            unhex::<32>(previous)?;
        }
        for (i, name) in self.body.state.requested_effects.iter().enumerate() {
            ensure!(
                plan.effects.iter().any(|e| &e.name == name),
                "Unplanned effect"
            );
            ensure!(
                !self.body.state.requested_effects[..i].contains(name),
                "Repeated effect"
            );
        }
        let key = VerifyingKey::from_bytes(&unhex::<32>(&self.body.worker_key)?)?;
        let sig = Signature::from_bytes(&unhex::<64>(&self.signature)?);
        key.verify_strict(&signing_bytes(&self.body)?, &sig)?;
        Ok(())
    }
}
fn signing_bytes(body: &CheckpointBody) -> Result<Vec<u8>> {
    let mut bytes = PREFIX.to_vec();
    bytes.extend(serde_json::to_vec(body)?);
    ensure!(bytes.len() <= MAX_CHECKPOINT_BYTES, "Checkpoint too large");
    Ok(bytes)
}

/// Content-addressed append-only blobs. The chain head, not a local "latest" file,
/// selects the checkpoint; a disk rollback therefore fails closed.
pub struct CheckpointStore {
    root: PathBuf,
}
impl CheckpointStore {
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        fs::create_dir_all(root.as_ref())?;
        Ok(Self {
            root: root.as_ref().to_path_buf(),
        })
    }
    pub fn put(&self, checkpoint: &SignedCheckpoint) -> Result<String> {
        let bytes = serde_json::to_vec(checkpoint)?;
        ensure!(bytes.len() <= MAX_CHECKPOINT_BYTES, "Checkpoint too large");
        let id = checkpoint.digest()?;
        let destination = self.root.join(format!("{id}.json"));
        // An unpublished temporary file is fsynced before an atomic no-replace link.
        let temp = self.root.join(format!(".{id}.{}.tmp", std::process::id()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        let outcome = (|| -> Result<()> {
            file.write_all(&bytes)?;
            file.sync_all()?;
            match fs::hard_link(&temp, &destination) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    ensure!(
                        fs::read(&destination)? == bytes,
                        "Checkpoint collision or corruption"
                    );
                }
                Err(error) => return Err(error.into()),
            }
            fs::File::open(&self.root)?.sync_all()?;
            Ok(())
        })();
        let cleanup = fs::remove_file(&temp);
        outcome?;
        cleanup?;
        Ok(id)
    }
    pub fn load(&self, id: &str) -> Result<SignedCheckpoint> {
        unhex::<32>(id)?;
        let file = fs::File::open(self.root.join(format!("{id}.json")))?;
        let mut bytes = Vec::new();
        file.take((MAX_CHECKPOINT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= MAX_CHECKPOINT_BYTES, "Checkpoint too large");
        let checkpoint: SignedCheckpoint = serde_json::from_slice(&bytes)?;
        ensure!(
            checkpoint.digest()? == id,
            "Stored checkpoint digest mismatch"
        );
        Ok(checkpoint)
    }
    pub fn lease(&self, domain: &Domain) -> Result<Lease> {
        let path = self
            .root
            .join(format!("{}.lease", digest(&serde_json::to_vec(domain)?)));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                writeln!(file, "{}", std::process::id())?;
                file.sync_all()?;
                Ok(Lease { path })
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                bail!("Coordinator lease already held; no timeout-based takeover")
            }
            Err(error) => Err(error.into()),
        }
    }
}
/// Single local writer. A process crash leaves a lock for explicit operator recovery;
/// never delete/reclaim it merely because time passed.
pub struct Lease {
    path: PathBuf,
}
impl Drop for Lease {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
