# STATEFLOW

Implemented in ../recovery/src/stateflow.rs: domain-separated Ed25519 checkpoints,
code/policy/plan and deployment binding, global sequence and previous-digest lineage,
expiry, chain-anchored head selection, bounded content-addressed durable storage,
and corruption/rollback rejection. Safe restoration is in the coordinator and
worker protocol. See ../recovery/README.md and ../../docs/phase3-validation.md.
