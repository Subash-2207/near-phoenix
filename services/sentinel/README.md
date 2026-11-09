# SENTINEL

The independent `Verifier` boundary is implemented by the local sandbox adapter in
../../integration-tests/src/sandbox_adapter.rs. It re-reads finalized policy,
verifies signed checkpoint bytes against the exact chain head, advances REWIND's
spending epoch before approving PHOENIX recovery, and separately authorizes each
pinned payment intent. It uses a distinct NEAR account from the coordinator.
Signatures do not prove semantic correctness of model output. Provider-specific
result/evidence policies and remote key management remain outside the local demo.
