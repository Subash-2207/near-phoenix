# REWIND coordinator boundary

The native escrow remains in ../../contracts/rewind-vault. Phase 3 adds opt-in
verifier-controlled epoch fencing. The off-chain recovery coordinator in
../recovery reconciles deterministic task/effect IDs against on-chain operations.
Succeeded is skipped; Pending and Uncertain are never retried by timeout. Failed
and Cancelled IDs remain tombstones. Reserved operations require approval bound
to the current spending epoch. Existing budgets, independent approval, solvency,
callback verification and refund exclusion all remain enforced on chain.
