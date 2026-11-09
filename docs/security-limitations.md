# Security limitations and submission caveats

NEAR PHOENIX v5.0 is a hackathon-stage prototype. Its tests and code review do
not constitute a professional security audit, formal verification, production
readiness review or guarantee of contract safety. No mainnet deployment or real
funds were used for the recorded validation.

## Known boundaries and risks

- **Sandbox coverage is local and bounded.** The five current Sandbox integration
  tests passed in the Nov 9, 2026 release validation. They use disposable local
  accounts and do not establish production deployment behavior, public-network
  finality, or safety against all failure modes. Repeat them on the presentation
  machine if it differs from this environment.
- **Browser verification remains unavailable.** TypeScript checks, dashboard
  tests and a production build passed, but no browser automation or visual
  hydration/console pass was available in this environment. An unedited human
  demo recording has not been captured.
- **Key custody is a prototype.** Sandbox fixtures use deterministic test keys.
  Production worker, coordinator, SENTINEL, GUARDIAN, owner and verifier keys need
  distinct secure custody, access controls, rotation and recovery procedures.
  Account separation does not prove separate human ownership or absence of
  collusion.
- **Agent output is not proved correct.** Signatures bind data to keys and prevent
  undetected changes; they do not establish that model reasoning, task results,
  recipients or business intent are correct. The demo uses a deterministic worker,
  not a connected LLM or production agent runtime.
- **Recovery is cross-contract and non-atomic.** The design fences REWIND before
  granting recovery in PHOENIX. Partial failure is intended to block payment and
  require reconciliation, but operational recovery of every outage pattern has
  not been established through deployment testing.
- **Uncertain transfers can remain locked.** The contract fails closed until an
  authentic callback resolves the transfer. Historical receipt-proof recovery
  for a callback that never arrives is not implemented.
- **Local storage and coordination have local limits.** Checkpoints and GUARDIAN
  audit files need protected durable storage and backup in production. Coordinator
  file leases are single-host, not distributed consensus; stale lease cleanup is
  manual. Process-local Control Plane/demo status does not survive restart; a
  running demo is marked interrupted.
- **GUARDIAN is not a host isolation layer.** On-chain quarantine blocks scoped
  contract actions. It does not terminate or sandbox an external worker, restrict
  its network, or protect a host from a compromised process. Event authenticity
  depends on observer keys and adapter correctness.
- **Loopback is not authentication.** The API binds to loopback and only permits
  `http://localhost:3000` as a browser CORS origin. Another process or user able
  to access the same machine can make loopback requests; CORS does not prevent
  that. Keep the service on a trusted development workstation.
- **Protocol/runtime coverage is bounded.** The contracts use NEAR SDK 5.30.0;
  the SDK metadata declares minimum protocol 88. A previously observed local
  sandbox reported protocol 86. Current WASM imports are reviewed, but testing
  against one sandbox runtime does not establish compatibility with all NEAR
  protocol releases or deployed validator configurations.
- **State migration is absent.** Phase 4+ contract layouts require fresh local
  deployments. This repository does not implement an in-place migration plan for
  earlier deployed state.

## Before any production consideration

At minimum, complete a professional independent security review; rerun the full
Phase 6 test script and all sandbox tests on the target OS/runtime; test failure,
upgrade and migration plans; obtain reproducible builds and deployment-artifact
attestation; design multisig/least-privilege administration; secure and rotate all
keys; protect durable checkpoint/audit storage; implement production worker
isolation and evidence adapters; review storage/gas limits; and perform a threat
model with the intended task/payment policy. None of those steps is implied by
the current test counts.
