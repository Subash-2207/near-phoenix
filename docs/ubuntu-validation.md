# Ubuntu validation — 2026-11-04

> Historical Phase 2 snapshot. Counts and sandbox limitations below predate
> Phase 3–6. See [current Phase 6 evidence](test-evidence.md) before quoting any
> results in a submission.

The existing implementation was inspected before editing. PHOENIX Core source,
application code, workspace dependencies and root Cargo.lock were preserved.
The initial baseline passed PHOENIX 16 tests and REWIND 59 tests.

REWIND now checks task principal conservation and aggregate recipient commitments
on each task update. Three additional tests cover invariant violations and the
case where a failed transfer callback precedes the native refund receipt. Failure
restores logical availability, but insufficient actual contract backing blocks
another dispatch. Uncertain transfers remain locked; no administrator can declare
an outcome or withdraw task funds.

A separate integration-tests Rust workspace adds two local sandbox tests covering
PHOENIX recovery/containment and REWIND real native transfer success/failure,
authorization, replay prevention, recipient budgets and authorized refunds.
The WASM build helper now uses the existing Cargo environment unless a populated
project-local registry index is present, preserving its earlier local-cache use.

## Actual results from this session

| Command | Actual result |
| --- | --- |
| `cargo test --workspace --offline --locked` | PASS: PHOENIX 16/16, REWIND 62/62; zero failures or ignored tests; doc-tests 0 |
| `cargo build --workspace --tests --offline --locked` | PASS |
| `cargo clippy --workspace --all-targets --offline --locked -- -D warnings` | PASS |
| `cargo fmt --all -- --check` | PASS |
| `cargo fmt --manifest-path integration-tests/Cargo.toml -- --check` | PASS (formatting only; not compilation) |
| `node --check scripts/build-wasm.mjs` | PASS |
| `RUSTFLAGS='--cfg near' cargo build --workspace --target wasm32-unknown-unknown --release --offline --locked` | BLOCKED: missing cached bumpalo 3.20.3 |
| Same WASM build with `CARGO_NET_RETRY=0` and network enabled | BLOCKED: cannot resolve static.crates.io when fetching bumpalo |
| `cargo test --manifest-path integration-tests/Cargo.toml --offline` | BLOCKED before compilation: near-workspaces absent from local registry cache |
| Same sandbox test with `CARGO_NET_RETRY=0` and network enabled | BLOCKED before compilation: cannot resolve index.crates.io/config.json |
| `node scripts/build-wasm.mjs` | BLOCKED: Node spawnSync rustc returned EPERM in this execution environment |

No near-sandbox executable is installed. Sandbox tests are authored but uncompiled
and unexecuted; their runtime/API compatibility has not been established. The
separate workspace has no generated lockfile because resolution could not finish.
No refreshed WASM artifacts were produced; any old artifacts/manifest and the
Windows phase2-validation.md describe prior source/builds, not the current changes.

The missing dependencies cannot be fetched within this session's restricted
network. Complete the commands in integration-tests/README.md on a host with
registry access and a protocol-compatible sandbox before claiming sandbox success.
No mainnet/testnet deployment, wallet use, or real funds occurred.

## Design references

- Official NEAR SDK promise/transfer API: https://docs.rs/near-sdk/latest/near_sdk/struct.Promise.html
- Native refunds need not precede callbacks: https://github.com/near/NEPs/blob/master/neps/nep-0616.md
- Official local sandbox test library: https://github.com/near/near-workspaces-rs
