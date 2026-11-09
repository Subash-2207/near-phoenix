# PHOENIX Control Plane

Phase 5 is implemented by the loopback-only Node backend in `../../apps/backend`
and the live Next.js dashboard in `../../apps/dashboard`. It reads finalized
contract state from a configured local NEAR RPC and orchestrates the local-only
Phase 5 sandbox demonstration using actual worker and contract assertions. It
does not provide general-purpose execution/payment routes. Setup, environment
variables, telemetry trust rules and limitations are documented in
`../../docs/phase5-control-plane.md`.
