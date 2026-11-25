use borsh::{BorshDeserialize, BorshSerialize};

pub type Key = [u8; 32];
pub const TAG: [u8; 8] = *b"PHXN0001";
pub const TASK_BYTES: usize = 373;

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub enum Phase {
    Running,
    Crashed,
    Quarantined,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Unauthorized = 1,
    InvalidInput,
    WrongPhase,
    StaleGeneration,
    StaleSequence,
    ApprovalRequired,
    InvalidWindow,
    InsufficientEscrow,
    Arithmetic,
}

#[derive(Clone, Debug, BorshDeserialize, BorshSerialize)]
pub enum Action {
    Create {
        id: Key,
        operator: Key,
        backup: Key,
        sentinel: Key,
        guardian: Key,
        heartbeat_window: u32,
        escrow: u64,
    },
    Heartbeat {
        generation: u64,
        sequence: u64,
    },
    Checkpoint {
        generation: u64,
        sequence: u64,
        hash: Key,
    },
    ReportCrash,
    Quarantine,
    ReviewQuarantine,
    ApproveRecovery {
        generation: u64,
        hash: Key,
        expires: i64,
    },
    Recover {
        generation: u64,
        hash: Key,
    },
    ApprovePayment {
        generation: u64,
        nonce: u64,
        amount: u64,
        expires: i64,
        hash: Key,
    },
    Settle {
        generation: u64,
        nonce: u64,
        amount: u64,
    },
    Refund,
}

#[derive(Clone, Debug, BorshDeserialize, BorshSerialize)]
pub struct Task {
    pub tag: [u8; 8],
    pub id: Key,
    pub owner: Key,
    pub operator: Key,
    pub backup: Key,
    pub sentinel: Key,
    pub guardian: Key,
    pub heartbeat_window: u32,
    pub phase: Phase,
    pub generation: u64,
    pub heartbeat_sequence: u64,
    pub heartbeat_at: i64,
    pub checkpoint_sequence: u64,
    pub checkpoint_hash: Key,
    pub recovery_expires: i64,
    pub recovery_count: u64,
    pub last_recovery_slot: u64,
    pub last_recovery_hash: Key,
    pub escrow_remaining: u64,
    pub escrow_paid: u64,
    pub escrow_refunded: u64,
    pub payment_nonce: u64,
    pub payment_amount: u64,
    pub payment_expires: i64,
}

fn require(condition: bool, error: Error) -> Result<(), Error> {
    if condition {
        Ok(())
    } else {
        Err(error)
    }
}

impl Task {
    pub fn create(owner: Key, action: &Action, now: i64) -> Result<Self, Error> {
        let Action::Create {
            id,
            operator,
            backup,
            sentinel,
            guardian,
            heartbeat_window,
            escrow,
        } = *action
        else {
            return Err(Error::InvalidInput);
        };
        let roles = [owner, operator, backup, sentinel, guardian];
        require(
            roles
                .iter()
                .enumerate()
                .all(|(i, key)| *key != [0; 32] && !roles[..i].contains(key)),
            Error::InvalidInput,
        )?;
        require(
            id != [0; 32] && (5..=86_400).contains(&heartbeat_window),
            Error::InvalidInput,
        )?;
        Ok(Self {
            tag: TAG,
            id,
            owner,
            operator,
            backup,
            sentinel,
            guardian,
            heartbeat_window,
            phase: Phase::Running,
            generation: 1,
            heartbeat_sequence: 0,
            heartbeat_at: now,
            checkpoint_sequence: 0,
            checkpoint_hash: [0; 32],
            recovery_expires: 0,
            recovery_count: 0,
            last_recovery_slot: 0,
            last_recovery_hash: [0; 32],
            escrow_remaining: escrow,
            escrow_paid: 0,
            escrow_refunded: 0,
            payment_nonce: 0,
            payment_amount: 0,
            payment_expires: 0,
        })
    }

    pub fn execute(
        &mut self,
        actor: Key,
        action: &Action,
        now: i64,
        slot: u64,
    ) -> Result<u64, Error> {
        match *action {
            Action::Create { .. } => return Err(Error::InvalidInput),
            Action::Heartbeat {
                generation,
                sequence,
            } => {
                self.require_operator(actor, generation, now)?;
                require(sequence > self.heartbeat_sequence, Error::StaleSequence)?;
                self.heartbeat_sequence = sequence;
                self.heartbeat_at = now;
            }
            Action::Checkpoint {
                generation,
                sequence,
                hash,
            } => {
                self.require_operator(actor, generation, now)?;
                require(sequence > self.checkpoint_sequence, Error::StaleSequence)?;
                require(hash != [0; 32], Error::InvalidInput)?;
                self.checkpoint_sequence = sequence;
                self.checkpoint_hash = hash;
                self.payment_amount = 0;
                self.payment_expires = 0;
            }
            Action::ReportCrash => {
                require(
                    actor == self.owner || actor == self.guardian,
                    Error::Unauthorized,
                )?;
                require(self.phase == Phase::Running, Error::WrongPhase)?;
                require(self.heartbeat_expired(now), Error::InvalidWindow)?;
                self.phase = Phase::Crashed;
                self.clear_approvals();
            }
            Action::Quarantine => {
                require(actor == self.guardian, Error::Unauthorized)?;
                require(
                    matches!(self.phase, Phase::Running | Phase::Crashed),
                    Error::WrongPhase,
                )?;
                self.phase = Phase::Quarantined;
                self.clear_approvals();
            }
            Action::ReviewQuarantine => {
                require(actor == self.owner, Error::Unauthorized)?;
                require(self.phase == Phase::Quarantined, Error::WrongPhase)?;
                self.phase = Phase::Crashed;
            }
            Action::ApproveRecovery {
                generation,
                hash,
                expires,
            } => {
                require(actor == self.sentinel, Error::Unauthorized)?;
                require(self.phase == Phase::Crashed, Error::WrongPhase)?;
                self.checkpoint(generation, hash)?;
                check_expiry(now, expires)?;
                self.recovery_expires = expires;
            }
            Action::Recover { generation, hash } => {
                require(actor == self.backup, Error::Unauthorized)?;
                require(self.phase == Phase::Crashed, Error::WrongPhase)?;
                self.checkpoint(generation, hash)?;
                require(self.recovery_expires > now, Error::ApprovalRequired)?;
                let next_generation = self.generation.checked_add(1).ok_or(Error::Arithmetic)?;
                let count = self
                    .recovery_count
                    .checked_add(1)
                    .ok_or(Error::Arithmetic)?;
                self.generation = next_generation;
                self.recovery_count = count;
                self.last_recovery_slot = slot;
                self.last_recovery_hash = hash;
                std::mem::swap(&mut self.operator, &mut self.backup);
                self.phase = Phase::Running;
                self.heartbeat_sequence = 0;
                self.heartbeat_at = now;
                self.clear_approvals();
            }
            Action::ApprovePayment {
                generation,
                nonce,
                amount,
                expires,
                hash,
            } => {
                require(actor == self.sentinel, Error::Unauthorized)?;
                self.require_running(generation, now)?;
                require(hash != [0; 32] && hash == self.checkpoint_hash, Error::ApprovalRequired)?;
                self.check_payment(nonce, amount)?;
                check_expiry(now, expires)?;
                self.payment_amount = amount;
                self.payment_expires = expires;
            }
            Action::Settle {
                generation,
                nonce,
                amount,
            } => {
                self.require_operator(actor, generation, now)?;
                self.check_payment(nonce, amount)?;
                require(
                    self.payment_amount == amount && self.payment_expires > now,
                    Error::ApprovalRequired,
                )?;
                self.escrow_paid = self
                    .escrow_paid
                    .checked_add(amount)
                    .ok_or(Error::Arithmetic)?;
                self.escrow_remaining -= amount;
                self.payment_nonce = nonce;
                self.clear_approvals();
                return Ok(amount);
            }
            Action::Refund => {
                require(actor == self.owner, Error::Unauthorized)?;
                require(
                    matches!(self.phase, Phase::Crashed | Phase::Quarantined),
                    Error::WrongPhase,
                )?;
                let amount = self.escrow_remaining;
                self.escrow_refunded = self
                    .escrow_refunded
                    .checked_add(amount)
                    .ok_or(Error::Arithmetic)?;
                self.escrow_remaining = 0;
                self.phase = Phase::Closed;
                self.clear_approvals();
                return Ok(amount);
            }
        }
        Ok(0)
    }

    fn checkpoint(&self, generation: u64, hash: Key) -> Result<(), Error> {
        require(self.generation == generation, Error::StaleGeneration)?;
        require(
            hash != [0; 32] && self.checkpoint_hash == hash,
            Error::InvalidInput,
        )
    }

    fn require_running(&self, generation: u64, now: i64) -> Result<(), Error> {
        require(self.phase == Phase::Running, Error::WrongPhase)?;
        require(self.generation == generation, Error::StaleGeneration)?;
        require(!self.heartbeat_expired(now), Error::InvalidWindow)
    }

    fn require_operator(&self, actor: Key, generation: u64, now: i64) -> Result<(), Error> {
        require(actor == self.operator, Error::Unauthorized)?;
        self.require_running(generation, now)
    }

    fn check_payment(&self, nonce: u64, amount: u64) -> Result<(), Error> {
        require(
            self.payment_nonce.checked_add(1).ok_or(Error::Arithmetic)? == nonce,
            Error::StaleSequence,
        )?;
        require(
            amount > 0 && amount <= self.escrow_remaining,
            Error::InsufficientEscrow,
        )
    }

    fn heartbeat_expired(&self, now: i64) -> bool {
        now >= self
            .heartbeat_at
            .saturating_add(i64::from(self.heartbeat_window))
    }

    fn clear_approvals(&mut self) {
        self.recovery_expires = 0;
        self.payment_expires = 0;
        self.payment_amount = 0;
    }
}

fn check_expiry(now: i64, expires: i64) -> Result<(), Error> {
    require(
        expires > now && expires <= now.saturating_add(3600),
        Error::InvalidWindow,
    )
}
