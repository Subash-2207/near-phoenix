# Stage D — Advanced GUARDIAN Security

Stage D extends the local/off-chain GUARDIAN detector and the read-only
Mission Control incident feed. It does not change contract payment,
settlement, refund, recovery, SENTINEL, or authorization rules.

## Detection and policy

`GuardianPolicy` is explicitly configured by the trusted monitor with observer
keys, authorization-failure threshold, event and payment rates, worker action
limit, risk-signal threshold, and event age/window bounds. Invalid zero limits,
weak or duplicate observer keys, and worker/observer key reuse are rejected.

Signed, domain-bound observer events are checked for signature, freshness,
monotonic nonce, evidence uniqueness and current fencing epoch. The detector
records fixed reason codes for repeated rejected approvals, unexpected or
duplicate settlement observations, replay attempts, compromised-agent
signals, unexpected recovery signals, abnormal worker activity, abnormal
event/payment frequency, and thresholded advisory risk signals. Free-form
instructions are not accepted as policy input.

An anomaly can only request a fail-closed, task/agent-scoped quarantine in the
configured domain. A risk score or observer event cannot release quarantine,
approve a payment, authorize recovery, or override SENTINEL/REWIND. Recovery
acknowledgement requires the independently queried chain state to show a
running agent, an unpaused task, and matching current epochs. Contract owner or
Guardian authorization remains responsible for actual on-chain state changes.

## Audit and Mission Control

Each accepted event and decision is written to a signed, append-only local
audit chain. Its head is anchored on-chain; restarts verify signatures,
sequence, predecessor digests and the remote anchor before processing more
events. A single-writer lease prevents concurrent monitors from appending to
the same incident log. Mission Control reads only audit records whose bytes
verify against the configured on-chain head and displays a read-only timeline
with sequence, event kind, decision/reason, epoch, evidence ID and bounded
structured details. An unavailable or invalid chain of custody produces no
trusted event list.

These records are trusted-observer evidence; the dashboard does not independently
prove the underlying off-chain behavior. A false positive may stop work, which
is the intended fail-safe direction. It cannot authorize funds or recovery.

## Local validation

Run the service unit and process tests:

```bash
cargo test --manifest-path services/recovery/Cargo.toml
```

Run contracts and the local NEAR sandbox adversarial suite:

```bash
cargo test --workspace
cargo test --manifest-path integration-tests/Cargo.toml
```

Run backend, frontend types, wallet session tests and production build:

```bash
npm test -w @phoenix/backend
npm run typecheck
npm run test:wallet -w @phoenix/dashboard
npm run build -w @phoenix/dashboard
```
