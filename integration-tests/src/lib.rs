//! Local sandbox integration tests; never connect to a public network.
#[cfg(test)]
mod recovery_receipt_sandbox;
#[cfg(test)]
mod security_sandbox;
#[cfg(test)]
mod tests {
    use anyhow::{Context, Result};
    use near_workspaces::types::NearToken;
    use near_workspaces::{Account, Contract};
    use serde_json::{Value, json};

    #[tokio::test]
    async fn sentinel_and_guardian_enforce_payment_and_quarantine() -> Result<()> {
        super::security_sandbox::sentinel_guardian_sandbox().await
    }
    use std::path::PathBuf;

    const N: u128 = 1_000_000_000_000_000_000_000_000;
    const TASK_BOND: u128 = N / 40;
    const OP_BOND: u128 = N / 100;

    fn wasm(name: &str) -> Result<Vec<u8>> {
        // Deploy cargo-near's final optimized artifact, never raw Cargo output.
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../target/near")
            .join(name)
            .join(format!("{name}.wasm"));
        let bytes = std::fs::read(&path).with_context(|| {
            format!(
                "Missing cargo-near artifact {}. Run bash scripts/build-near.sh first.",
                path.display()
            )
        })?;
        eprintln!("Deploying {} ({} bytes)", path.display(), bytes.len());
        Ok(bytes)
    }
    async fn call(
        who: &Account,
        contract: &Contract,
        method: &str,
        args: Value,
        deposit: u128,
    ) -> Result<Value> {
        let result = who
            .call(contract.id(), method)
            .args_json(args)
            .deposit(NearToken::from_yoctonear(deposit))
            .max_gas()
            .transact()
            .await?;
        // Includes chained callback execution, not just the first receipt.
        let bytes = result
            .into_result()
            .with_context(|| format!("{method} failed on {}", contract.id()))?
            .raw_bytes()?;
        if bytes.is_empty() {
            Ok(Value::Null)
        } else {
            Ok(serde_json::from_slice(&bytes)?)
        }
    }
    async fn denied(
        who: &Account,
        contract: &Contract,
        method: &str,
        args: Value,
        deposit: u128,
        reason: &str,
    ) -> Result<()> {
        let result = who
            .call(contract.id(), method)
            .args_json(args)
            .deposit(NearToken::from_yoctonear(deposit))
            .max_gas()
            .transact()
            .await?;
        assert!(result.is_failure(), "{method} unexpectedly succeeded");
        assert!(
            format!("{result:?}").contains(reason),
            "Unexpected failure: {result:?}"
        );
        Ok(())
    }
    async fn view(contract: &Contract, method: &str, args: Value) -> Result<Value> {
        Ok(contract.view(method).args_json(args).await?.json()?)
    }
    fn amount(v: &Value, field: &str) -> u128 {
        v[field].as_str().unwrap().parse().unwrap()
    }

    #[tokio::test]
    async fn phoenix_recovery_authorization_and_containment() -> Result<()> {
        let worker = near_workspaces::sandbox().await?;
        let core = worker.dev_deploy(&wasm("phoenix_core")?).await?;
        let owner = worker.dev_create_account().await?;
        let operator = worker.dev_create_account().await?;
        let sentinel = worker.dev_create_account().await?;
        let attacker = worker.dev_create_account().await?;
        call(
            &owner,
            &core,
            "new",
            json!({"owner":owner.id(),"guardian":sentinel.id()}),
            0,
        )
        .await?;
        let agent = operator.id();
        call(&owner, &core, "register_agent", json!({"agent_id":agent,"operator":operator.id(),"sentinel":sentinel.id(),"timeout_ns":"1000000000"}), 0).await?;
        denied(
            &attacker,
            &core,
            "heartbeat",
            json!({"agent_id":agent,"generation":"0"}),
            0,
            "Operator only",
        )
        .await?;
        worker.fast_forward(20).await?;
        call(
            &attacker,
            &core,
            "report_crash",
            json!({"agent_id":agent}),
            0,
        )
        .await?;
        denied(
            &operator,
            &core,
            "recover",
            json!({"agent_id":agent,"generation":"0"}),
            0,
            "Independent approval required",
        )
        .await?;
        denied(
            &attacker,
            &core,
            "approve_recovery",
            json!({"agent_id":agent,"generation":"0"}),
            0,
            "Sentinel only",
        )
        .await?;
        call(
            &sentinel,
            &core,
            "approve_recovery",
            json!({"agent_id":agent,"generation":"0"}),
            0,
        )
        .await?;
        call(
            &operator,
            &core,
            "recover",
            json!({"agent_id":agent,"generation":"0"}),
            0,
        )
        .await?;
        let state = view(&core, "get_agent", json!({"agent_id":agent})).await?;
        assert_eq!(state["generation"], "1");
        assert_eq!(state["status"], "Running");
        assert_eq!(state["recovery_approved"], false);
        denied(
            &operator,
            &core,
            "recover",
            json!({"agent_id":agent,"generation":"0"}),
            0,
            "Stale generation",
        )
        .await?;
        call(&owner, &core, "set_paused", json!({"paused":true}), 0).await?;
        call(&sentinel, &core, "contain", json!({"agent_id":agent}), 0).await?;
        assert_eq!(
            view(&core, "get_agent", json!({"agent_id":agent})).await?["status"],
            "Contained"
        );
        Ok(())
    }

    #[tokio::test]
    async fn rewind_native_receipts_failures_replay_and_refunds() -> Result<()> {
        let worker = near_workspaces::sandbox().await?;
        let vault = worker.dev_deploy(&wasm("rewind_vault")?).await?;
        let depositor = worker.dev_create_account().await?;
        let executor = worker.dev_create_account().await?;
        let verifier = worker.dev_create_account().await?;
        let recipient = worker.dev_create_account().await?;
        let attacker = worker.dev_create_account().await?;
        // A nonexistent child cannot be created by a native Transfer action.
        let missing = format!("missing.{}", recipient.id());
        call(
            &depositor,
            &vault,
            "new",
            json!({"owner":depositor.id(),"guardian":verifier.id()}),
            0,
        )
        .await?;
        let now = worker.view_block().await?.timestamp();
        call(&depositor, &vault, "create_task", json!({
            "task_id":"task", "executor":executor.id(), "verifier":verifier.id(),
            "recipients":[{"account_id":recipient.id(),"limit":(6*N).to_string()}, {"account_id":missing,"limit":(4*N).to_string()}],
            "escrow_amount":(10*N).to_string(), "expires_at":(now + 86_400_000_000_000u64).to_string()
        }), 10*N + TASK_BOND).await?;
        let reserve = |op: &str, to: &str, value: u128| json!({"task_id":"task","operation_id":op,"recipient":to,"amount":value.to_string(),"commitment":"ab".repeat(32)});
        denied(
            &attacker,
            &vault,
            "reserve_payment",
            reserve("bad", recipient.id().as_str(), N),
            OP_BOND,
            "Executor only",
        )
        .await?;
        denied(
            &executor,
            &vault,
            "reserve_payment",
            reserve("bad", attacker.id().as_str(), N),
            OP_BOND,
            "Unauthorized recipient",
        )
        .await?;
        denied(
            &executor,
            &vault,
            "reserve_payment",
            reserve("bad", recipient.id().as_str(), 11 * N),
            OP_BOND,
            "Insufficient task balance",
        )
        .await?;
        denied(
            &executor,
            &vault,
            "reserve_payment",
            reserve("bad", recipient.id().as_str(), 7 * N),
            OP_BOND,
            "Recipient budget exceeded",
        )
        .await?;
        call(
            &executor,
            &vault,
            "reserve_payment",
            reserve("pay", recipient.id().as_str(), 3 * N),
            OP_BOND,
        )
        .await?;
        denied(
            &executor,
            &vault,
            "settle_payment",
            json!({"operation_id":"pay"}),
            0,
            "Verified approval required",
        )
        .await?;
        call(
            &verifier,
            &vault,
            "authorize_refund",
            json!({"task_id":"task"}),
            0,
        )
        .await?;
        denied(
            &depositor,
            &vault,
            "refund",
            json!({"task_id":"task","operation_id":"race"}),
            OP_BOND,
            "Unresolved operations",
        )
        .await?;
        denied(
            &attacker,
            &vault,
            "on_transfer",
            json!({"operation_id":"pay"}),
            0,
            "private",
        )
        .await?;
        call(
            &verifier,
            &vault,
            "approve_payment",
            json!({"operation_id":"pay","expected_commitment":"ab".repeat(32)}),
            0,
        )
        .await?;
        denied(
            &attacker,
            &vault,
            "settle_payment",
            json!({"operation_id":"pay"}),
            0,
            "Executor only",
        )
        .await?;
        let before = recipient.view_account().await?.balance.as_yoctonear();
        assert_eq!(
            call(
                &executor,
                &vault,
                "settle_payment",
                json!({"operation_id":"pay"}),
                0
            )
            .await?,
            true
        );
        assert_eq!(
            recipient.view_account().await?.balance.as_yoctonear(),
            before + 3 * N
        );
        denied(
            &executor,
            &vault,
            "settle_payment",
            json!({"operation_id":"pay"}),
            0,
            "Operation not reserved",
        )
        .await?;
        denied(
            &executor,
            &vault,
            "reserve_payment",
            reserve("pay", recipient.id().as_str(), N),
            OP_BOND,
            "Operation ID already used",
        )
        .await?;
        // Real failed native transfer and its private callback restore available funds.
        call(
            &executor,
            &vault,
            "reserve_payment",
            reserve("fail", &missing, 2 * N),
            OP_BOND,
        )
        .await?;
        call(
            &verifier,
            &vault,
            "approve_payment",
            json!({"operation_id":"fail","expected_commitment":"ab".repeat(32)}),
            0,
        )
        .await?;
        assert_eq!(
            call(
                &executor,
                &vault,
                "settle_payment",
                json!({"operation_id":"fail"}),
                0
            )
            .await?,
            false
        );
        let failed = view(&vault, "get_operation", json!({"operation_id":"fail"})).await?;
        assert_eq!(failed["state"], "Failed");
        let task = view(&vault, "get_task", json!({"task_id":"task"})).await?;
        assert_eq!(amount(&task, "available"), 7 * N);
        assert_eq!(amount(&task, "pending"), 0);
        assert_eq!(task["recipients"][1]["committed"], "0");
        denied(
            &attacker,
            &vault,
            "refund",
            json!({"task_id":"task","operation_id":"steal"}),
            OP_BOND,
            "Depositor only",
        )
        .await?;
        assert_eq!(
            call(
                &depositor,
                &vault,
                "refund",
                json!({"task_id":"task","operation_id":"refund"}),
                OP_BOND
            )
            .await?,
            true
        );
        let task = view(&vault, "get_task", json!({"task_id":"task"})).await?;
        assert_eq!(amount(&task, "paid"), 3 * N);
        assert_eq!(amount(&task, "refunded"), 7 * N);
        assert_eq!(amount(&task, "available"), 0);
        assert_eq!(
            view(&vault, "accounting", json!({})).await?,
            json!(["0", "0"])
        );
        denied(
            &depositor,
            &vault,
            "refund",
            json!({"task_id":"task","operation_id":"refund2"}),
            OP_BOND,
            "Nothing to refund",
        )
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod recovery_sandbox;
#[cfg(test)]
mod sandbox_adapter;

#[cfg(test)]
#[tokio::test]
async fn phase7_unified_sandbox_recovery_receipt_and_guardian_fail_closed() -> anyhow::Result<()> {
    recovery_sandbox::run_demo().await
}
