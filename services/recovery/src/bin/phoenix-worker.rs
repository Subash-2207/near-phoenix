//! Local deterministic worker used to demonstrate real process failure/restart.
//! Seeds arrive on stdin, never command-line arguments, environment or logs.
use anyhow::{Result, ensure};
use ed25519_dalek::SigningKey;
use phoenix_recovery::*;
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};

fn main() -> Result<()> {
    let mut key: Option<SigningKey> = None;
    let mut plan: Option<Plan> = None;
    let mut epoch = 0;
    let mut state: Option<TaskState> = None;
    let mut restored: Option<(u64, String)> = None;
    let stdout = io::stdout();
    let mut output = stdout.lock();
    for line in io::stdin().lock().lines() {
        let response = (|| -> Result<Value> {
            let command: Value = serde_json::from_str(&line?)?;
            let action = command["action"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Missing action"))?;
            if action == "init" {
                ensure!(key.is_none(), "Already initialized");
                let seed = unhex::<32>(
                    command["seed"]
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!("Missing seed"))?,
                )?;
                let signing = SigningKey::from_bytes(&seed);
                let config: Plan = serde_json::from_value(command["plan"].clone())?;
                config.validate()?;
                ensure!(
                    config.worker_keys.contains(&worker_key(&signing)),
                    "Worker not registered"
                );
                epoch = command["epoch"]
                    .as_u64()
                    .ok_or_else(|| anyhow::anyhow!("Missing epoch"))?;
                plan = Some(config);
                let public = worker_key(&signing);
                key = Some(signing);
                return Ok(json!({"worker_key":public}));
            }
            let signing = key
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Initialize worker first"))?;
            let config = plan.as_ref().unwrap();
            match action {
                "start" => {
                    ensure!(
                        state.is_none() && epoch == 0,
                        "Task already started or requires restoration"
                    );
                    state = Some(TaskState {
                        completed_steps: 0,
                        result: String::new(),
                        requested_effects: vec![],
                    });
                    Ok(json!(state))
                }
                "step" => {
                    let current = state
                        .as_mut()
                        .ok_or_else(|| anyhow::anyhow!("No task state"))?;
                    current.completed_steps = current
                        .completed_steps
                        .checked_add(1)
                        .ok_or_else(|| anyhow::anyhow!("Step overflow"))?;
                    current.result = command["result"]
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!("Missing result"))?
                        .to_owned();
                    current.requested_effects =
                        serde_json::from_value(command["requested_effects"].clone())?;
                    Ok(json!(current))
                }
                "checkpoint" => {
                    let body = CheckpointBody {
                        domain: config.domain.clone(),
                        plan_digest: digest(&serde_json::to_vec(config)?),
                        epoch,
                        sequence: command["sequence"]
                            .as_u64()
                            .ok_or_else(|| anyhow::anyhow!("Missing sequence"))?,
                        previous_digest: serde_json::from_value(
                            command["previous_digest"].clone(),
                        )?,
                        worker_key: worker_key(signing),
                        issued_at: command["issued_at"]
                            .as_u64()
                            .ok_or_else(|| anyhow::anyhow!("Missing time"))?,
                        expires_at: command["expires_at"]
                            .as_u64()
                            .ok_or_else(|| anyhow::anyhow!("Missing expiry"))?,
                        state: state
                            .clone()
                            .ok_or_else(|| anyhow::anyhow!("No task state"))?,
                    };
                    Ok(json!(SignedCheckpoint::sign(body, signing)?))
                }
                "pulse" => Ok(json!(Heartbeat::sign(
                    HeartbeatBody {
                        domain: config.domain.clone(),
                        worker_key: worker_key(signing),
                        epoch,
                        sequence: command["sequence"]
                            .as_u64()
                            .ok_or_else(|| anyhow::anyhow!("Missing sequence"))?,
                        issued_at: command["issued_at"]
                            .as_u64()
                            .ok_or_else(|| anyhow::anyhow!("Missing time"))?,
                    },
                    signing
                )?)),
                "restore" => {
                    let checkpoint: SignedCheckpoint =
                        serde_json::from_value(command["checkpoint"].clone())?;
                    let now = command["now"]
                        .as_u64()
                        .ok_or_else(|| anyhow::anyhow!("Missing time"))?;
                    checkpoint.verify(config, now)?;
                    let requested_epoch = command["epoch"]
                        .as_u64()
                        .ok_or_else(|| anyhow::anyhow!("Missing epoch"))?;
                    ensure!(
                        requested_epoch == epoch
                            && checkpoint.body.epoch.checked_add(1) == Some(epoch),
                        "Restoration fence mismatch"
                    );
                    let identity = (epoch, checkpoint.digest()?);
                    if let Some(old) = &restored {
                        ensure!(old == &identity, "Different restoration for same epoch");
                    } else {
                        state = Some(checkpoint.body.state.clone());
                        restored = Some(identity);
                    }
                    Ok(json!(state))
                }
                _ => anyhow::bail!("Unsupported worker action"),
            }
        })();
        let message = match response {
            Ok(value) => json!({"ok":value}),
            Err(error) => json!({"error":error.to_string()}),
        };
        serde_json::to_writer(&mut output, &message)?;
        writeln!(output)?;
        output.flush()?;
    }
    Ok(())
}
