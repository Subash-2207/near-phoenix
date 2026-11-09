//! Runnable local supervisor demonstration. No public-network mode or credentials.
#[path = "../src/recovery_sandbox.rs"]
mod recovery_sandbox;
#[path = "../src/sandbox_adapter.rs"]
mod sandbox_adapter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    recovery_sandbox::run_demo().await
}
