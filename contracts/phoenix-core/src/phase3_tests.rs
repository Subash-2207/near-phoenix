use super::*;
use near_sdk::{test_utils::VMContextBuilder, testing_env};
fn id(value: &str) -> AccountId {
    value.parse().unwrap()
}
fn context(caller: &str, now: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(id("core.testnet"))
        .predecessor_account_id(id(caller))
        .block_timestamp(now)
        .build());
}
fn setup() -> PhoenixCore {
    context("owner.testnet", 0);
    let mut core = PhoenixCore::new(id("owner.testnet"), id("guardian.testnet"));
    core.register_agent(
        id("agent.testnet"),
        id("coordinator.testnet"),
        id("sentinel.testnet"),
        U64(1_000_000_000),
    );
    core.configure_stateflow(
        id("agent.testnet"),
        "task".into(),
        "11".repeat(32),
        vec!["22".repeat(32)],
    );
    context("coordinator.testnet", 1);
    core.commit_checkpoint(
        id("agent.testnet"),
        U64(0),
        U64(1),
        "ab".repeat(32),
        None,
        U64(10_000_000_000),
    );
    core
}
fn crashed() -> PhoenixCore {
    let mut core = setup();
    context("watcher.testnet", 1_000_000_001);
    core.report_crash(id("agent.testnet"));
    core
}
fn approved() -> PhoenixCore {
    let mut core = crashed();
    context("sentinel.testnet", 1_000_000_002);
    core.approve_checkpoint_recovery(
        id("agent.testnet"),
        U64(0),
        "ab".repeat(32),
        "22".repeat(32),
    );
    core
}
fn recover(core: &mut PhoenixCore) {
    context("coordinator.testnet", 1_000_000_003);
    core.recover_checkpoint(
        id("agent.testnet"),
        U64(0),
        "ab".repeat(32),
        "22".repeat(32),
    );
}
#[test]
fn bound_backup_recovery_consumes_grant_and_fences_old_generation() {
    let mut core = approved();
    recover(&mut core);
    let agent = core.get_agent(id("agent.testnet")).unwrap();
    assert_eq!(agent.generation.0, 1);
    assert_eq!(agent.status, Status::Running);
    assert!(!agent.recovery_approved);
    assert_eq!(agent.operator, id("coordinator.testnet"));
    let flow = core.get_stateflow(id("agent.testnet")).unwrap();
    assert_eq!(flow.worker_key, "22".repeat(32));
    assert_eq!(flow.head.as_ref().unwrap().generation, U64(0));
    assert!(flow.grant.is_none());
    assert!(flow.backup_keys.is_empty());
}
#[test]
#[should_panic(expected = "Checkpoint recovery required")]
fn legacy_recovery_cannot_bypass_checkpoint_policy() {
    let mut core = approved();
    context("coordinator.testnet", 1_000_000_003);
    core.recover(id("agent.testnet"), U64(0));
}
#[test]
#[should_panic(expected = "Checkpoint recovery required")]
fn legacy_approval_cannot_bypass_checkpoint_policy() {
    let mut core = crashed();
    context("sentinel.testnet", 1_000_000_002);
    core.approve_recovery(id("agent.testnet"), U64(0));
}
#[test]
#[should_panic(expected = "Operator only")]
fn worker_cannot_anchor_checkpoints_directly() {
    let mut core = setup();
    context("worker.testnet", 2);
    core.commit_checkpoint(
        id("agent.testnet"),
        U64(0),
        U64(2),
        "cd".repeat(32),
        Some("ab".repeat(32)),
        U64(10_000_000_000),
    );
}
#[test]
#[should_panic(expected = "Checkpoint sequence mismatch")]
fn checkpoint_rollback_rejected() {
    let mut core = setup();
    context("coordinator.testnet", 2);
    core.commit_checkpoint(
        id("agent.testnet"),
        U64(0),
        U64(1),
        "cd".repeat(32),
        Some("ab".repeat(32)),
        U64(10_000_000_000),
    );
}
#[test]
#[should_panic(expected = "Checkpoint lineage mismatch")]
fn checkpoint_fork_rejected() {
    let mut core = setup();
    context("coordinator.testnet", 2);
    core.commit_checkpoint(
        id("agent.testnet"),
        U64(0),
        U64(2),
        "cd".repeat(32),
        Some("ff".repeat(32)),
        U64(10_000_000_000),
    );
}
#[test]
#[should_panic(expected = "Heartbeat expired; recovery required")]
fn expired_heartbeat_cannot_commit_checkpoint() {
    let mut core = setup();
    // Registration heartbeat was at time zero with a one-second timeout.
    // Equality is expired by Core's >= lease rule.
    context("coordinator.testnet", 1_000_000_000);
    core.commit_checkpoint(
        id("agent.testnet"),
        U64(0),
        U64(2),
        "cd".repeat(32),
        Some("ab".repeat(32)),
        U64(10_000_000_000),
    );
}
#[test]
#[should_panic(expected = "Checkpoint mismatch")]
fn grant_cannot_authorize_another_checkpoint() {
    let mut core = crashed();
    context("sentinel.testnet", 1_000_000_002);
    core.approve_checkpoint_recovery(
        id("agent.testnet"),
        U64(0),
        "cd".repeat(32),
        "22".repeat(32),
    );
}
#[test]
#[should_panic(expected = "Backup not allowed")]
fn unregistered_backup_rejected() {
    let mut core = crashed();
    context("sentinel.testnet", 1_000_000_002);
    core.approve_checkpoint_recovery(
        id("agent.testnet"),
        U64(0),
        "ab".repeat(32),
        "33".repeat(32),
    );
}
#[test]
#[should_panic(expected = "Sentinel only")]
fn coordinator_cannot_approve_own_recovery() {
    let mut core = crashed();
    context("coordinator.testnet", 1_000_000_002);
    core.approve_checkpoint_recovery(
        id("agent.testnet"),
        U64(0),
        "ab".repeat(32),
        "22".repeat(32),
    );
}
#[test]
#[should_panic(expected = "Stale generation")]
fn recovery_grant_replay_rejected() {
    let mut core = approved();
    recover(&mut core);
    recover(&mut core);
}
#[test]
#[should_panic(expected = "Operator only")]
fn unauthorized_account_cannot_activate_approved_backup() {
    let mut core = approved();
    context("attacker.testnet", 1_000_000_003);
    core.recover_checkpoint(
        id("agent.testnet"),
        U64(0),
        "ab".repeat(32),
        "22".repeat(32),
    );
}
#[test]
#[should_panic(expected = "Stale generation")]
fn stale_epoch_cannot_activate_approved_backup() {
    let mut core = approved();
    context("coordinator.testnet", 1_000_000_003);
    core.recover_checkpoint(
        id("agent.testnet"),
        U64(1),
        "ab".repeat(32),
        "22".repeat(32),
    );
}
#[test]
#[should_panic(expected = "Checkpoint expired")]
fn expired_grant_cannot_restore() {
    let mut core = approved();
    context("coordinator.testnet", 10_000_000_000);
    core.recover_checkpoint(
        id("agent.testnet"),
        U64(0),
        "ab".repeat(32),
        "22".repeat(32),
    );
}
#[test]
fn containment_revokes_bound_grant() {
    let mut core = approved();
    context("guardian.testnet", 1_000_000_003);
    core.contain(id("agent.testnet"));
    assert!(core
        .get_stateflow(id("agent.testnet"))
        .unwrap()
        .grant
        .is_none());
    assert!(
        !core
            .get_agent(id("agent.testnet"))
            .unwrap()
            .recovery_approved
    );
}
#[test]
#[should_panic(expected = "Stale generation")]
fn primary_epoch_heartbeat_rejected_after_restore() {
    let mut core = approved();
    recover(&mut core);
    core.heartbeat(id("agent.testnet"), U64(0));
}
