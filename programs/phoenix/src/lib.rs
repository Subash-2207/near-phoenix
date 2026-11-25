use borsh::BorshDeserialize;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
#[allow(deprecated)]
use solana_program::{system_instruction, system_program};

pub mod state;
use state::{Action, Error, Task, TAG, TASK_BYTES};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

impl From<Error> for ProgramError {
    fn from(error: Error) -> Self {
        Self::Custom(error as u32)
    }
}

pub fn process_instruction(program: &Pubkey, infos: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let action = Action::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)?;
    let accounts = &mut infos.iter();
    let actor = next_account_info(accounts)?;
    let task_account = next_account_info(accounts)?;
    if !actor.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !task_account.is_writable || task_account.key == actor.key {
        return Err(ProgramError::InvalidAccountData);
    }

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    if matches!(action, Action::Create { .. }) {
        let system = next_account_info(accounts)?;
        let task = Task::create(actor.key.to_bytes(), &action, now)?;
        return create(program, actor, task_account, system, &task);
    }

    if task_account.owner != program || task_account.data_len() != TASK_BYTES {
        return Err(ProgramError::InvalidAccountOwner);
    }
    let mut task = {
        let state = task_account.try_borrow_data()?;
        Task::try_from_slice(&state).map_err(|_| ProgramError::InvalidAccountData)?
    };
    if task.tag != TAG || task_address(program, &task).0 != *task_account.key {
        return Err(ProgramError::InvalidSeeds);
    }
    if matches!(action, Action::ApprovePayment { .. }) {
        let owner = accounts.next().ok_or(Error::Unauthorized)?;
        if !owner.is_signer || owner.key.to_bytes() != task.owner {
            return Err(Error::Unauthorized.into());
        }
    }
    let amount = task.execute(actor.key.to_bytes(), &action, now, clock.slot)?;
    if amount > 0 {
        if !actor.is_writable {
            return Err(ProgramError::InvalidAccountData);
        }
        let floor = Rent::get()?.minimum_balance(TASK_BYTES);
        let required = floor
            .checked_add(task.escrow_remaining)
            .ok_or(Error::Arithmetic)?;
        let source = task_account
            .lamports()
            .checked_sub(amount)
            .ok_or(Error::InsufficientEscrow)?;
        if source < required {
            return Err(Error::InsufficientEscrow.into());
        }
        let destination = actor
            .lamports()
            .checked_add(amount)
            .ok_or(Error::Arithmetic)?;
        **task_account.try_borrow_mut_lamports()? = source;
        **actor.try_borrow_mut_lamports()? = destination;
    }
    store(task_account, &task)?;
    if matches!(action, Action::Recover { .. }) {
        msg!(
            "PHOENIX recovery generation={} slot={}",
            task.generation,
            task.last_recovery_slot
        );
    }
    if amount > 0 {
        msg!(
            "PHOENIX escrow disbursement lamports={} nonce={}",
            amount,
            task.payment_nonce
        );
    }
    Ok(())
}

fn task_address(program: &Pubkey, task: &Task) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"task", &task.owner, &task.id], program)
}

fn create<'a>(
    program: &Pubkey,
    payer: &AccountInfo<'a>,
    account: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    task: &Task,
) -> ProgramResult {
    if *system.key != system_program::ID
        || account.owner != system.key
        || !account.data_is_empty()
        || !payer.is_writable
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let (expected, bump) = task_address(program, task);
    if expected != *account.key {
        return Err(ProgramError::InvalidSeeds);
    }
    let bump_seed = [bump];
    let seeds: &[&[u8]] = &[b"task", &task.owner, &task.id, &bump_seed];
    let target = Rent::get()?
        .minimum_balance(TASK_BYTES)
        .checked_add(task.escrow_remaining)
        .ok_or(Error::Arithmetic)?;
    let infos = [payer.clone(), account.clone(), system.clone()];
    // Existing lamports on the PDA must not block allocation. Keep any donations
    // outside the task's recorded escrow and charge the owner the full principal.
    let reserve = target - task.escrow_remaining;
    let funded = reserve
        .saturating_sub(account.lamports())
        .checked_add(task.escrow_remaining)
        .ok_or(Error::Arithmetic)?;
    if account.lamports() == 0 {
        invoke_signed(
            &system_instruction::create_account(
                payer.key,
                account.key,
                target,
                TASK_BYTES as u64,
                program,
            ),
            &infos,
            &[seeds],
        )?;
    } else {
        if funded > 0 {
            invoke(
                &system_instruction::transfer(payer.key, account.key, funded),
                &infos,
            )?;
        }
        invoke_signed(
            &system_instruction::allocate(account.key, TASK_BYTES as u64),
            &infos,
            &[seeds],
        )?;
        invoke_signed(
            &system_instruction::assign(account.key, program),
            &infos,
            &[seeds],
        )?;
    }
    store(account, task)
}

fn store(account: &AccountInfo, task: &Task) -> ProgramResult {
    let data = borsh::to_vec(task).map_err(|_| ProgramError::InvalidAccountData)?;
    if data.len() != TASK_BYTES {
        return Err(ProgramError::InvalidAccountData);
    }
    account.try_borrow_mut_data()?.copy_from_slice(&data);
    Ok(())
}
