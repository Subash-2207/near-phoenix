use anyhow::{Result, ensure};
use ed25519_dalek::SigningKey;
use phoenix_recovery::*;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
};
fn request(child: &mut Child, value: Value) -> Result<Value> {
    let input = child.stdin.as_mut().unwrap();
    serde_json::to_writer(&mut *input, &value)?;
    writeln!(input)?;
    input.flush()?;
    let mut line = String::new();
    ensure!(
        BufReader::new(child.stdout.as_mut().unwrap()).read_line(&mut line)? > 0,
        "Worker exited"
    );
    let result: Value = serde_json::from_str(&line)?;
    ensure!(result.get("error").is_none(), "{}", result["error"]);
    Ok(result["ok"].clone())
}
struct Process(Child);
impl Process {
    fn spawn() -> Result<Self> {
        Ok(Self(
            Command::new(env!("CARGO_BIN_EXE_phoenix-worker"))
                .env_clear()
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()?,
        ))
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[test]
fn real_primary_process_crash_and_signed_backup_restoration() -> Result<()> {
    let primary = SigningKey::from_bytes(&[1; 32]);
    let backup = SigningKey::from_bytes(&[2; 32]);
    let plan = Plan {
        domain: Domain {
            network: "sandbox".into(),
            deployment: "process-test".into(),
            core_id: "core.test".into(),
            vault_id: "vault.test".into(),
            agent_id: "agent.test".into(),
            task_id: "task".into(),
            execution_id: "execution".into(),
            code_digest: "ab".repeat(32),
            policy_digest: "cd".repeat(32),
        },
        worker_keys: vec![worker_key(&primary), worker_key(&backup)],
        effects: vec![],
    };
    let mut process = Process::spawn()?;
    request(
        &mut process.0,
        json!({"action":"init","seed":hex(&[1;32]),"plan":plan,"epoch":0}),
    )?;
    request(&mut process.0, json!({"action":"start"}))?;
    request(
        &mut process.0,
        json!({"action":"step","result":"computed state","requested_effects":[]}),
    )?;
    let cp: SignedCheckpoint = serde_json::from_value(request(
        &mut process.0,
        json!({"action":"checkpoint","sequence":1,"previous_digest":null,"issued_at":100,"expires_at":1000}),
    )?)?;
    cp.verify(&plan, 101)?;
    process.0.kill()?;
    ensure!(!process.0.wait()?.success(), "Expected primary crash");
    let mut recovered = Process::spawn()?;
    request(
        &mut recovered.0,
        json!({"action":"init","seed":hex(&[2;32]),"plan":plan,"epoch":1}),
    )?;
    let state: TaskState = serde_json::from_value(request(
        &mut recovered.0,
        json!({"action":"restore","epoch":1,"checkpoint":cp,"now":102}),
    )?)?;
    assert_eq!(state.completed_steps, 1);
    assert_eq!(state.result, "computed state");
    request(
        &mut recovered.0,
        json!({"action":"step","result":"continued","requested_effects":[]}),
    )?;
    let repeated: TaskState = serde_json::from_value(request(
        &mut recovered.0,
        json!({"action":"restore","epoch":1,"checkpoint":cp,"now":103}),
    )?)?;
    assert_eq!(repeated.completed_steps, 2);
    let next: SignedCheckpoint = serde_json::from_value(request(
        &mut recovered.0,
        json!({"action":"checkpoint","sequence":2,"previous_digest":cp.digest()?,"issued_at":104,"expires_at":1000}),
    )?)?;
    next.verify(&plan, 105)?;
    assert_eq!(next.body.epoch, 1);
    assert_eq!(next.body.worker_key, worker_key(&backup));
    Ok(())
}
