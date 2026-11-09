#![allow(dead_code)]
// Control-plane flow: real Phase 3 failure/recovery followed by Phase 4
// suspicious-payment rejection, settlement-once and GUARDIAN quarantine.
#[path = "../src/recovery_sandbox.rs"]
mod recovery_sandbox;
#[path = "../src/sandbox_adapter.rs"]
mod sandbox_adapter;
#[path = "../src/security_sandbox.rs"]
mod security_sandbox;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    recovery_sandbox::run_demo().await?;
    security_sandbox::sentinel_guardian_sandbox().await?;
    println!(
        "PHOENIX_CONTROL_EVENT {}",
        serde_json::json!({"kind":"demo_complete","details":{}})
    );
    Ok(())
}
