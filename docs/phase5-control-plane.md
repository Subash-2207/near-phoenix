# Phase 5 · PHOENIX Control Plane

The Next.js dashboard is connected to a loopback-only Node API. `/api/control-plane`
reads PHOENIX Core and REWIND view calls from `NEAR_RPC_URL`, pins all calls in one
response to the same finalized block hash, and reports unavailable state explicitly
if configuration or RPC access is missing. It displays heartbeat freshness and
epochs, STATEFLOW head, active registered backup, Core/REWIND SENTINEL nonces,
GUARDIAN quarantine/audit information and escrow accounting/selected operations.
The API accepts only HTTP on loopback, binds to `127.0.0.1`, and refuses a non-local
network setting. It does not expose payment, recovery, withdrawal or unpause routes.

GUARDIAN audit rows are shown only if the audit directory and Ed25519 public key
are configured, the signed audit sequence/chain verifies, the local audit tail
matches the on-chain anchored digest, and the stored domain matches the configured
Core SENTINEL policy. REWIND operations are read by ID because the contract exposes
no collection scan; configure `PHOENIX_OPERATION_IDS` as a comma-separated list.

The trusted browser origin is exactly `http://localhost:3000`; open the dashboard
using that hostname. Its API base defaults to `http://127.0.0.1:3001`. The backend
returns an exact `Access-Control-Allow-Origin` value for the dashboard, handles
preflight only for implemented routes/methods, and requires the trusted Origin on
the demo-start POST. It binds only to `127.0.0.1`; no wildcard CORS or credential
sharing is enabled.

## Run locally

Configure real local contract IDs and the local node's RPC address in the API shell:

```sh
NEAR_NETWORK=localnet \
NEAR_RPC_URL=http://127.0.0.1:3030 \
PHOENIX_CORE_ID=phoenix.testnet \
REWIND_VAULT_ID=rewind.testnet \
PHOENIX_AGENT_ID=agent.testnet \
PHOENIX_TASK_ID=task-1 \
PHOENIX_OPERATION_IDS=payment-1,payment-2 \
npm run dev:api
```

Replace the example IDs with accounts deployed only on a local sandbox. In another
shell run `npm run dev:dashboard`. The browser dashboard refreshes telemetry from
the API every two seconds. To show Guardian's authenticated audit events, also set
`PHOENIX_GUARDIAN_AUDIT_DIR` and `PHOENIX_GUARDIAN_AUDIT_PUBLIC_KEY` (64 lowercase
hex characters).

The **Run local demonstration** button launches `cargo run --offline --locked --manifest-path
integration-tests/Cargo.toml --example phase5`. That single drill uses ephemeral
local sandbox deployments and a real recovery-worker subprocess: it commits a
primary checkpoint, settles a payment once, crashes the primary, restores the
authorized backup, verifies duplicate settlement prevention, rejects an attacker
payment attempt, and applies/anchors GUARDIAN quarantine. Backend progress events
are emitted only after the Rust harness has observed the operation and passed its
assertions. A zero process exit alone is insufficient: all required proof events
must arrive before the backend reports success.

The drill's recovery and SENTINEL/GUARDIAN scenarios currently use sequential
fresh sandbox deployments because Phase 3 and Phase 4 harnesses are separate
fixtures. Live dashboard telemetry is read from the separately configured local
RPC; the demo does not silently substitute its ephemeral data for those cards.
The sandbox requires localhost sockets and built NEAR WASM artifacts. No public
network or real funds are used.
