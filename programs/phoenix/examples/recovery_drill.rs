use phoenix_solana_program::state::{Action, Key, Task};

const OWNER: Key = [1; 32];
const WORKER: Key = [2; 32];
const BACKUP: Key = [3; 32];
const SENTINEL: Key = [4; 32];
const GUARDIAN: Key = [5; 32];

fn main() {
    let hash = solana_program::hash::hash(b"phoenix-example-checkpoint-v1").to_bytes();
    let create = Action::Create {
        id: [6; 32],
        operator: WORKER,
        backup: BACKUP,
        sentinel: SENTINEL,
        guardian: GUARDIAN,
        heartbeat_window: 20,
        escrow: 2_000_000_000,
    };
    let mut task = Task::create(OWNER, &create, 100).unwrap();
    let steps = [
        (
            WORKER,
            Action::Heartbeat {
                generation: 1,
                sequence: 1,
            },
            101,
            "Worker heartbeat",
        ),
        (
            WORKER,
            Action::Checkpoint {
                generation: 1,
                sequence: 1,
                hash,
            },
            102,
            "Checkpoint committed",
        ),
        (GUARDIAN, Action::ReportCrash, 121, "Heartbeat expired"),
        (
            GUARDIAN,
            Action::Quarantine,
            122,
            "Guardian quarantined task",
        ),
        (
            OWNER,
            Action::ReviewQuarantine,
            123,
            "Owner reviewed quarantine",
        ),
        (
            SENTINEL,
            Action::ApproveRecovery {
                generation: 1,
                hash,
                expires: 160,
            },
            124,
            "Sentinel approved recovery",
        ),
        (
            BACKUP,
            Action::Recover {
                generation: 1,
                hash,
            },
            125,
            "Backup recovered task",
        ),
        (
            SENTINEL,
            Action::ApprovePayment {
                generation: 2,
                nonce: 1,
                amount: 500_000_000,
                expires: 160,
                hash,
            },
            126,
            "Sentinel approved payout",
        ),
        (
            BACKUP,
            Action::Settle {
                generation: 2,
                nonce: 1,
                amount: 500_000_000,
            },
            127,
            "Approved payout settled",
        ),
    ];
    println!(r#"{{"source":"Local execution of the Rust program rules","steps":["#);
    snapshot(&task, "Task created", 100);
    for (actor, action, time, name) in steps {
        task.execute(actor, &action, time, time as u64).unwrap();
        print!(",\n");
        snapshot(&task, name, time);
    }
    println!("\n]}}");
}

fn snapshot(task: &Task, label: &str, time: i64) {
    let hex = task
        .last_recovery_hash
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    print!(
        r#"{{"label":"{label}","time":{time},"phase":"{:?}","generation":"{}","checkpointSequence":"{}","heartbeatSequence":"{}","recoveryCount":"{}","recoverySlot":"{}","recoveryHash":"{hex}","escrowRemaining":"{}","escrowPaid":"{}","escrowRefunded":"{}","paymentNonce":"{}","recoveryApproval":"{}","paymentApproval":"{}"}}"#,
        task.phase,
        task.generation,
        task.checkpoint_sequence,
        task.heartbeat_sequence,
        task.recovery_count,
        task.last_recovery_slot,
        task.escrow_remaining,
        task.escrow_paid,
        task.escrow_refunded,
        task.payment_nonce,
        task.recovery_expires,
        task.payment_expires,
    );
}
