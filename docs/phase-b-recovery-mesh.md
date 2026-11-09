# Phase B: Multi-Agent Recovery Mesh

## Recovery path

PHOENIX Core's owner-configured STATEFLOW backup list is ordered. The recovery coordinator walks that finalized chain order and chooses the first candidate with a fresh, valid signature for exactly the next epoch. Worker response order does not change selection. A failed or silent worker is omitted; later configured candidates can take over. A key outside both the pinned plan and on-chain registry cannot be selected.

The independent SENTINEL authorizes one checkpoint digest, current source epoch, and one backup identity. Core stores that grant with an on-chain expiration bounded by the signed approval and checkpoint. The selected operator consumes it with `recover_checkpoint`; Core atomically advances generation, updates the active worker, consumes the grant, and writes the recovery transition. Stale operators, conflicting grants, repeat recovery, and attempts from another registered backup are rejected by contract checks.

STATEFLOW checkpoint hashes and the existing Proof-of-Recovery receipt path remain unchanged. REWIND continues to use the stable task payment ID and contract execution epoch; recovery does not reserve a second operation or give a backup payment authority. Settlement remains subject to existing independent approval and REWIND state transitions.

## Expired lease behavior

`expire_recovery_lease` is permissionless, but succeeds only when Core's block timestamp is at or after the stored grant deadline and the agent remains crashed. It clears the pending grant and approval bit without activating a worker or advancing the epoch. A fresh Sentinel authorization is required afterward. An active lease cannot be stolen.

The recovery service also holds a local exclusive checkpoint-store lease. It intentionally does not time out or auto-reclaim on process age: a second writer on another host cannot safely infer that a coordinator is dead from elapsed wall time. Operators must resolve a stale local lock explicitly after checking the process and chain state. On-chain epoch fencing remains authoritative across hosts.

## Validation

Run the service and all five ephemeral sandbox tests from a normal Ubuntu terminal:

```sh
bash scripts/test-phase-b.sh
```

The script runs workspace contract tests, recovery-service tests, builds/import-checks both local NEAR WASM contracts, and runs the local sandbox suite. No public network or real funds are used.

Mesh coverage includes registry-order selection despite reversed heartbeat arrival, fallback when the preferred worker is unavailable, rejection of an unregistered heartbeat signer, expired/active recovery lease behavior, stale epoch rejection, conflict rejection, and stable REWIND duplicate-payment behavior.

## Limits

Backup identity selection and chain transitions are verifiable; worker readiness still depends on the off-chain monitor's authenticated heartbeat transport. The local process lease is not a distributed consensus mechanism. Sentinel availability and truthful independent review are operational dependencies. These tests are not a professional security audit.
