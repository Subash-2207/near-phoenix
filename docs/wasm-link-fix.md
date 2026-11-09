# REWIND sandbox WASM link fix — 2026-11-04

## Root cause and exact imports

The installed sandbox binary reports:

```
neard (release 2.13.4) (build 2.13.4)
commit 44f7ae6cd7ef08bab604e20a473bf77e35d4c993
min_protocol 83, protocol 86
```

The integration lockfile resolves near-workspaces 0.23.0 and near-sandbox 0.3.16.
The installed near-sandbox library selects binary 2.13.4 by default. NEAR SDK
5.30.0's Cargo metadata declares minimum protocol 88. This is a real SDK/runtime
mismatch, not a deposit, authorization or callback-result validation error.

The original raw REWIND artifact (SHA-256
`53f29e3b81774e923a0c7c03e7b753314174e2a90dc5bae5a59bd154407f365b`)
and its original cargo-near artifact (SHA-256
`321dcde36393eb140bd6843c73c20c06a856c22f4e0c5f1bc4d8600b839326e7`)
both imported these four functions that are **absent** from nearcore 2.13.4's
runtime import definitions:

```
env.promise_batch_action_universal_state_init
env.promise_batch_action_transfer_to_gas_key
env.promise_batch_action_add_gas_key_with_full_access
env.promise_batch_action_add_gas_key_with_function_call
```

There are multiple unresolvable imports, not just one. The generic link error
does not identify which is rejected first. Inspecting both WASM import tables
and the exact runtime source identifies the full incompatible set. Changing only
the artifact path or running wasm-opt cannot remove the root cause: the original
optimized cargo-near WASM contained the same unsupported imports.

SDK 5.30's generic `PromiseAction` dispatcher matches all action variants and
calls their host functions. Using `Promise::new(...).transfer(...).then(...)`
keeps that generic dispatcher reachable, including unrelated gas-key and
universal-state-init action branches. Those imports are required at WASM link
time even though the escrow never executes those branches. PHOENIX Core does not
construct promises, explaining why its artifact can initialize on this runtime.

Additionally, the integration loader previously read raw Cargo output under
`target/wasm32-unknown-unknown/release`, bypassing the cargo-near optimized files
that had been built separately.

## Fix

REWIND retains SDK 5.30.0 and now constructs exactly the native transfer and
private callback with safe SDK `env` primitives:

1. Mark operation Pending and persist the locked principal, budget and in-flight
   accounting before dispatch.
2. Create a recipient batch and append the exact native transfer amount.
3. Create a dependent callback batch addressed to the current contract.
4. Append `on_transfer` with JSON operation ID, zero attached deposit, 20 Tgas,
   and zero unused-gas weight.
5. Use `env::promise_return(callback)` so the transaction still resolves to the
   final callback boolean. These Rust methods now return unit; the SDK's generated
   void wrapper persists state without overriding that explicit promise return.

No authorization, independent verification, balance/budget check, storage bond,
unique ID check, refund exclusion, backing/gas check, callback predecessor/result
validation, or uncertain-outcome lock was removed or relaxed. No new unsafe code,
financial bypass, SDK downgrade, or runtime feature override was introduced.
The existing receipt test additionally asserts zero unused-gas weight; the same
78 unit tests remain present and pass.

The integration loader now reads only cargo-near output and prints the path and
size. Missing files produce a build instruction, with no fallback to raw WASM.
`scripts/build-near.sh` builds both contracts with wasm-opt enabled and audits
those exact files via `scripts/inspect-near-wasm.mjs`. The audit rejects unreviewed
host imports and records hashes in `artifacts/near-wasm-manifest.json`.

The fixed REWIND artifact imports 24 reviewed host functions, down from 41. All
four incompatible functions and other unrelated Promise actions are gone. The
remaining imported names and native transfer/callback signatures match the
2.13.4 host interface. This is a targeted native-escrow compatibility fix, not a
claim that every SDK 5.30 feature works on protocol 86. Its metadata still declares
88; future use of newer features requires an appropriate runtime. Node parsing
and import-name auditing alone do not establish runtime acceptance, receipt gas
costs or full protocol compatibility.

## Actual results

| Check | Result |
| --- | --- |
| `cargo test --workspace --offline --locked` | PASS: PHOENIX 16/16, REWIND 62/62; 0 failed, 0 ignored |
| `cargo clippy --workspace --all-targets --offline --locked -- -D warnings` | PASS |
| Workspace and integration `cargo fmt ... --check` | PASS |
| cargo-near build, both contracts, `--locked --no-abi` with wasm-opt | PASS |
| `CARGO_NET_OFFLINE=true bash scripts/build-near.sh` | PASS, including canonical artifact audit |
| `cargo test --manifest-path integration-tests/Cargo.toml --offline --locked -- --nocapture` | Compiled; 0 passed / 2 failed before contract execution because sandbox socket creation is blocked in this session |
| User's normal-terminal result before this fix | Reported 1 passed (PHOENIX), 1 failed (REWIND link error) |
| Runtime integration results after this fix | Pending normal-terminal execution; no sandbox pass claimed |

Fresh optimized artifacts:

| Contract | Path | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| PHOENIX | `target/near/phoenix_core/phoenix_core.wasm` | 134669 | `836da5cfd85bf3f725bc3a43558c570dbf9daa35384b7c8ca6ee1e20759876c6` |
| REWIND | `target/near/rewind_vault/rewind_vault.wasm` | 173341 | `c54617c77c79f44aa338eb3bb06a9fd1fee8a4769441f57de4b30001f14099e1` |

Unlike earlier sessions, dependencies, cargo-near and the sandbox executable are
now cached and builds succeed. The remaining execution restriction is localhost
socket creation. Neither sandbox test reaches WASM deployment in this session.

## Exact normal Ubuntu terminal commands

```sh
cd /path/to/near-phoenix
cargo test --workspace --locked
bash scripts/build-near.sh
cargo test --manifest-path integration-tests/Cargo.toml --locked -- --nocapture
```

For just REWIND with detailed errors:

```sh
RUST_BACKTRACE=1 cargo test --manifest-path integration-tests/Cargo.toml --locked rewind_native_receipts_failures_replay_and_refunds -- --nocapture
```

No downloads are needed if the current caches remain intact; optionally set
`CARGO_NET_OFFLINE=true` for the commands above. Do not use `--no-wasmopt` or copy
raw Cargo output over the optimized artifacts. The integration assertions cover
native deposits, exact recipient balance increase, one-time settlement,
unauthorized payments, real failed native transfers and callback reconciliation,
refunds and principal accounting. Permanently failed callbacks remain a separate
availability limitation: uncertain funds stay locked rather than becoming
withdrawable without proof.

No deployment to public networks or real-fund use occurred.

## Primary evidence

- Exact local near-sdk 5.30.0 `src/promise.rs` (`PromiseAction::add`, generic
  dispatcher), `src/environment/env.rs` (batch primitives), and near-sdk-macros
  5.30.0's void-return code generation were inspected.
- [nearcore 2.13.4 runtime host imports and protocol/config gates](https://github.com/near/nearcore/blob/2.13.4/runtime/near-vm-runner/src/imports.rs)
- Installed near-sandbox 0.3.16 `DEFAULT_NEAR_SANDBOX_VERSION` and actual binary
  `--version` output were inspected; integration-tests/Cargo.lock pins the library.
- Local `cargo near build non-reproducible-wasm --help` explicitly requires its
  wasm-opt postprocessing for modern Rust. That postprocessing remains enabled.
