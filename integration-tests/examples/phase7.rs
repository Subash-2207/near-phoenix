//! Unified local sandbox workflow used by the Phase 7 backend demo.
#![allow(dead_code)]
#[path = "../src/recovery_sandbox.rs"]
mod recovery_sandbox;
#[path = "../src/sandbox_adapter.rs"]
mod sandbox_adapter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    recovery_sandbox::run_demo().await
}
