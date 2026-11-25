use borsh::{from_slice, to_vec};
use phoenix_solana_program::state::{Action, Error, Key, Phase, Task, TASK_BYTES};

const OWNER: Key = [1; 32];
const WORKER: Key = [2; 32];
const BACKUP: Key = [3; 32];
const SENTINEL: Key = [4; 32];
const GUARDIAN: Key = [5; 32];
const HASH: Key = [7; 32];

fn create() -> Task {
    Task::create(
        OWNER,
        &Action::Create {
            id: [6; 32],
            operator: WORKER,
            backup: BACKUP,
            sentinel: SENTINEL,
            guardian: GUARDIAN,
            heartbeat_window: 10,
            escrow: 200,
        },
        100,
    )
    .unwrap()
}

fn apply(task: &mut Task, actor: Key, action: Action, time: i64) -> Result<u64, Error> {
    task.execute(actor, &action, time, time as u64)
}

fn checkpoint(task: &mut Task) {
    apply(
        task,
        WORKER,
        Action::Checkpoint {
            generation: 1,
            sequence: 1,
            hash: HASH,
        },
        101,
    )
    .unwrap();
}

#[test]
fn task_layout_is_fixed_and_roles_cannot_overlap() {
    let task = create();
    let bytes = to_vec(&task).unwrap();
    assert_eq!(bytes.len(), TASK_BYTES);
    assert_eq!(from_slice::<Task>(&bytes).unwrap().owner, OWNER);
    assert_eq!(
        Task::create(
            OWNER,
            &Action::Create {
                id: [6; 32],
                operator: OWNER,
                backup: BACKUP,
                sentinel: SENTINEL,
                guardian: GUARDIAN,
                heartbeat_window: 10,
                escrow: 0
            },
            100
        )
        .unwrap_err(),
        Error::InvalidInput
    );
}

#[test]
fn recovery_requires_expired_heartbeat_exact_checkpoint_and_independent_approval() {
    let mut task = create();
    checkpoint(&mut task);
    assert_eq!(
        apply(
            &mut task,
            WORKER,
            Action::Checkpoint {
                generation: 1,
                sequence: 1,
                hash: [8; 32]
            },
            102
        ),
        Err(Error::StaleSequence)
    );
    assert_eq!(
        apply(&mut task, GUARDIAN, Action::ReportCrash, 109),
        Err(Error::InvalidWindow)
    );
    assert_eq!(
        apply(&mut task, WORKER, Action::ReportCrash, 110),
        Err(Error::Unauthorized)
    );
    apply(&mut task, GUARDIAN, Action::ReportCrash, 110).unwrap();
    let approve = Action::ApproveRecovery {
        generation: 1,
        hash: HASH,
        expires: 115,
    };
    let recover = Action::Recover {
        generation: 1,
        hash: HASH,
    };
    assert_eq!(
        apply(&mut task, BACKUP, recover.clone(), 111),
        Err(Error::ApprovalRequired)
    );
    assert_eq!(
        apply(&mut task, OWNER, approve.clone(), 111),
        Err(Error::Unauthorized)
    );
    apply(&mut task, SENTINEL, approve, 111).unwrap();
    assert_eq!(
        apply(
            &mut task,
            BACKUP,
            Action::Recover {
                generation: 1,
                hash: [8; 32]
            },
            112
        ),
        Err(Error::InvalidInput)
    );
    assert_eq!(
        apply(&mut task, BACKUP, recover.clone(), 115),
        Err(Error::ApprovalRequired)
    );
    apply(
        &mut task,
        SENTINEL,
        Action::ApproveRecovery {
            generation: 1,
            hash: HASH,
            expires: 125,
        },
        116,
    )
    .unwrap();
    apply(&mut task, BACKUP, recover.clone(), 117).unwrap();
    assert_eq!(task.generation, 2);
    assert_eq!(task.last_recovery_slot, 117);
    assert_eq!(task.last_recovery_hash, HASH);
    assert_eq!(task.recovery_expires, 0);
    assert_eq!(
        apply(&mut task, BACKUP, recover, 118),
        Err(Error::Unauthorized)
    );
    assert_eq!(
        apply(
            &mut task,
            WORKER,
            Action::Heartbeat {
                generation: 1,
                sequence: 2
            },
            118
        ),
        Err(Error::Unauthorized)
    );
    assert_eq!(
        apply(
            &mut task,
            BACKUP,
            Action::Heartbeat {
                generation: 1,
                sequence: 2
            },
            118
        ),
        Err(Error::StaleGeneration)
    );
}

#[test]
fn quarantine_invalidates_approved_recovery_and_requires_owner_review() {
    let mut task = create();
    checkpoint(&mut task);
    apply(&mut task, OWNER, Action::ReportCrash, 110).unwrap();
    apply(
        &mut task,
        SENTINEL,
        Action::ApproveRecovery {
            generation: 1,
            hash: HASH,
            expires: 140,
        },
        111,
    )
    .unwrap();
    apply(&mut task, GUARDIAN, Action::Quarantine, 112).unwrap();
    assert_eq!(task.phase, Phase::Quarantined);
    assert_eq!(
        apply(&mut task, GUARDIAN, Action::ReviewQuarantine, 113),
        Err(Error::Unauthorized)
    );
    apply(&mut task, OWNER, Action::ReviewQuarantine, 113).unwrap();
    assert_eq!(
        apply(
            &mut task,
            BACKUP,
            Action::Recover {
                generation: 1,
                hash: HASH
            },
            114
        ),
        Err(Error::ApprovalRequired)
    );
}

#[test]
fn payout_is_exact_and_once_and_refund_closes_the_task() {
    let mut task = create();
    apply(&mut task, WORKER, Action::Checkpoint { generation: 1, sequence: 1, hash: HASH }, 101).unwrap();
    let approve = Action::ApprovePayment {
        generation: 1,
        nonce: 1,
        amount: 80,
        expires: 109,
        hash: HASH,
    };
    let settle = Action::Settle {
        generation: 1,
        nonce: 1,
        amount: 80,
    };
    assert_eq!(
        apply(&mut task, WORKER, settle.clone(), 101),
        Err(Error::ApprovalRequired)
    );
    apply(&mut task, SENTINEL, approve.clone(), 102).unwrap();
    assert_eq!(
        apply(&mut task, BACKUP, settle.clone(), 103),
        Err(Error::Unauthorized)
    );
    assert_eq!(
        apply(
            &mut task,
            WORKER,
            Action::Settle {
                generation: 1,
                nonce: 1,
                amount: 79
            },
            103
        ),
        Err(Error::ApprovalRequired)
    );
    assert_eq!(
        apply(&mut task, WORKER, settle.clone(), 109),
        Err(Error::ApprovalRequired)
    );
    apply(
        &mut task,
        SENTINEL,
        Action::ApprovePayment {
            generation: 1,
            nonce: 1,
            amount: 80,
            expires: 111,
            hash: HASH,
        },
        109,
    )
    .unwrap();
    assert_eq!(apply(&mut task, WORKER, settle.clone(), 109), Ok(80));
    assert_eq!(
        apply(&mut task, WORKER, settle, 109),
        Err(Error::StaleSequence)
    );
    assert_eq!(task.escrow_remaining, 120);
    assert_eq!(task.escrow_paid, 80);
    apply(&mut task, GUARDIAN, Action::Quarantine, 110).unwrap();
    assert_eq!(
        apply(&mut task, GUARDIAN, Action::Refund, 111),
        Err(Error::Unauthorized)
    );
    assert_eq!(apply(&mut task, OWNER, Action::Refund, 111), Ok(120));
    assert_eq!(task.escrow_refunded, 120);
    assert_eq!(task.phase, Phase::Closed);
    assert_eq!(
        apply(&mut task, OWNER, Action::Refund, 112),
        Err(Error::WrongPhase)
    );
}
