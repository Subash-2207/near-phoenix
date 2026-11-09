# Security model (current summary)

For current threat boundaries and items required before production use, see
[Security limitations](security-limitations.md). The current adversarial test
matrix and results are in [Phase 6 review](phase6-security-review.md) and
[test evidence](test-evidence.md).

## Enforced boundaries

- NEAR predecessor identity is checked on privileged contract methods; caller
  identity is not inferred from a prior signer.
- Core recovery requires an independent signed approval bound to the checkpoint,
  selected backup, generation, security revision and expiry. Recovery advances
  the epoch and consumes its grant.
- Containment revokes outstanding approval. Only the owner can reopen a contained
  agent for fresh verification; that step alone does not restart execution.
- Fenced REWIND tasks require their current epoch and independent approval.
  Recipient allowlists, per-recipient limits, task accounting, unique operation
  IDs and actual attached deposits remain enforced on chain.
- Native transfers settle through authenticated private callbacks. Refunds cannot
  bypass unresolved operations; uncertain outcomes remain locked. There is no
  global owner withdrawal of user escrow.
- GUARDIAN quarantine is scoped and does not authorize a transfer. SENTINEL
  approvals are fresh, task/action-bound signatures with nonce replay checks.
- The Control Plane binds to loopback and exposes read telemetry plus a local demo
  trigger. It has no direct payment, refund, recovery, withdrawal or unpause API.

## Trust assumptions

Owner, operator, verifier, SENTINEL, GUARDIAN and worker keys must remain distinct
where configured and be securely held. Account separation alone does not prove
independent human control. A compromised operator can disrupt availability; a
compromised Sentinel can issue unsafe approvals within its authority; a Guardian
can cause denial of service by quarantining. Contract checks remain the financial
authority, but this code does not prove AI output or task-result correctness.

## Historical note

Earlier phase reports describe narrower implementations at the time they were
written. They are retained as history; use the current overview and Phase 6
evidence for submission claims.
