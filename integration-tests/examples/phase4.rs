#![allow(dead_code)]
// Local-only Phase 3 recovery followed by Phase 4 SENTINEL/GUARDIAN demonstration.
#[path = "../src/recovery_sandbox.rs"]
mod recovery_sandbox;
#[path = "../src/sandbox_adapter.rs"]
mod sandbox_adapter;
#[path = "../src/security_sandbox.rs"]
mod security_sandbox;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    recovery_sandbox::run_demo().await?;
    security_sandbox::sentinel_guardian_sandbox().await
}
