# Installation and local run guide

All commands below are for Ubuntu/WSL Ubuntu. They use local development state
and do not deploy contracts to a public network. Never paste a wallet seed or
private key into the example configuration.

## Prerequisites

- Rust stable with the `wasm32-unknown-unknown` target and Cargo.
- `cargo-near` CLI compatible with the pinned NEAR SDK 5.30.0 contracts.
- Node.js 22 or newer and npm (the current workspace has been checked with Node
  26.13.0 / npm 11.20.0).
- A Linux-compatible NEAR sandbox runtime for integration tests. The test crate
  uses `near-workspaces` 0.23.0 and creates disposable sandbox accounts.
- Enough disk for Rust, Node and WASM build caches; Cargo integration-test target
  output can be large.

Check what is installed:

```sh
rustc --version
cargo --version
cargo near --version
rustup target list --installed
node --version
npm --version
```

Install Rust/Node using the distribution or toolchain manager you already trust.
Install `cargo-near` using its official distribution instructions. Do not
disable TLS verification or use an untrusted Cargo registry mirror. Add the
WASM target if it is absent:

```sh
rustup target add wasm32-unknown-unknown
```

The integration suite may require downloading its sandbox binary and Rust
dependencies the first time. Run it in a normal Ubuntu terminal with networking
and local socket permissions. The current release validation completed the
Sandbox suite successfully in this environment; older reports describe
restricted runs where local sockets were unavailable.

## Install JavaScript dependencies and compile

From the repository root:

```sh
npm ci
cargo test --workspace --locked
cargo test --manifest-path services/recovery/Cargo.toml --locked
npm run typecheck
npm test -w @phoenix/backend
bash scripts/build-near.sh
```

The recovery-service crate is a separate Cargo workspace, so run its tests
separately. The NEAR build script writes the optimized contract artifacts used by
the sandbox tests and audits their imports/exports. Do not load raw Cargo WASM
artifacts instead of `target/near/<name>/<name>.wasm`.

Run the full validation script when ready:

```sh
bash scripts/test-phase6.sh
```

It reports every stage and exits nonzero if any stage fails.

For a single command that builds and runs the unified recovery scenario through
the backend receipt gate, use:

```sh
npm run demo:local
```

The command writes fresh evidence under `/tmp` (or `$TMPDIR`) and prints the
path. It does not launch the dashboard browser.

## Run the sandbox security tests

Build the contracts, then run all current integration tests:

```sh
bash scripts/build-near.sh
cargo test --manifest-path integration-tests/Cargo.toml --locked -- --nocapture
```

The five integration tests cover recovery authorization/containment, REWIND
deposits and callbacks/refunds, SENTINEL/GUARDIAN payment/quarantine, and the
primary-process-crash recovery flow. They use only ephemeral sandbox accounts.
No `near deploy`, testnet or mainnet account is needed.

## Run the interactive dashboard demo

First build the NEAR WASM contracts. Start the backend in one terminal:

```sh
cd /path/to/near-phoenix
NEAR_NETWORK=localnet npm run dev:api
```

The API binds to `127.0.0.1:3001`; the dashboard defaults to that API address.
Start the dashboard in another terminal:

```sh
cd /path/to/near-phoenix
npm run dev:dashboard
```

Open **http://localhost:3000** (the exact trusted browser origin). Press **Run
local demonstration** and follow the event timeline. The backend launches the
unified Phase 7B sandbox harness as a child process. It is separate from the RPC
telemetry cards.

To populate live dashboard cards, run a local NEAR node/sandbox RPC and deploy
fresh contract instances locally. In the API shell, set the IDs and RPC address
for those local instances before starting `npm run dev:api`:

```sh
export NEAR_NETWORK=localnet
export NEAR_RPC_URL=http://127.0.0.1:3030
export PHOENIX_CORE_ID=phoenix.testnet
export REWIND_VAULT_ID=rewind.testnet
export PHOENIX_AGENT_ID=agent.testnet
export PHOENIX_TASK_ID=task-1
export PHOENIX_OPERATION_IDS=payment-1,payment-2
npm run dev:api
```

Replace the sample IDs with accounts/contracts on that local node. Do not use
public RPC URLs. For GUARDIAN audit events, additionally configure
`PHOENIX_GUARDIAN_AUDIT_DIR` and `PHOENIX_GUARDIAN_AUDIT_PUBLIC_KEY` using a
local test audit directory and its public key. Do not configure a private key in
the Control Plane. Without local contracts/RPC configuration, the UI correctly
shows telemetry as unavailable while the independent ephemeral demo may still
run.

## Shutdown and cleanup

Stop each development server with Ctrl-C. Backend shutdown marks an in-progress
drill interrupted and sends termination signals to its child process group. Build
products and downloaded dependency caches are disposable but can be large; keep
them out of a source submission archive. See the root `.gitignore` and
[test evidence](test-evidence.md).
