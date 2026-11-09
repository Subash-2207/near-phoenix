# WSL2 networking investigation — 2026-11-04

Dependency access was **not restored**. The commands in this session run inside a
restricted execution environment. This makes their DNS failures insufficient to
diagnose a broken WSL host resolver. No system DNS, TLS, proxy, Cargo registry,
firewall or Windows settings were changed. Contract source and dependencies were
preserved.

## Direct evidence

- Kernel: x86_64 Ubuntu WSL2, 6.18.54.1-microsoft-standard-WSL2.
- Creating AF_INET or AF_INET6 sockets, both TCP and UDP, immediately returns
  `PermissionError: [Errno 1] Operation not permitted`. No connection attempt or
  DNS lookup is needed to reproduce this denial. AF_UNIX sockets work.
- `/proc/net/dev` exposes only loopback. `/proc/net/route` has no routes.
  `ip addr` and `ip route` cannot create their netlink sockets (`EPERM`).
- Process status reports `NoNewPrivs: 1`, `Seccomp: 2`, one seccomp filter and
  no effective capabilities. Together with the socket denials, this is consistent
  with execution sandbox isolation. The exact filtering rule is not inspectable.
- `getaddrinfo` fails for index.crates.io, static.crates.io, github.com and
  example.com with temporary name-resolution failure. Both crates HTTPS HEAD
  requests fail before a TLS handshake, with curl exit 6.
- Thus neither outbound dependency access **nor local TCP sandbox RPC** can work
  here. A different nameserver, Cargo mirror or HTTP proxy cannot solve a policy
  that prevents Internet sockets from being created.

The read-only diagnostic `python3 scripts/diagnose-network.py` reproduces the
checks and returns 2 for socket policy denial, 1 for DNS/HTTPS failures, and 0
when its probes succeed. This session's output is saved in
[network-diagnostics.json](../artifacts/network-diagnostics.json). It never prints
proxy values or credentials and never changes networking or TLS verification.

## Resolver, registry and proxy inspection

`/etc/resolv.conf` is WSL-generated and contains `nameserver 10.255.255.254`.
This is the documented default DNS tunneling address, not evidence of an invalid
resolver. `/etc/wsl.conf` enables systemd and specifies the user; it does not
disable automatic resolver generation. The inspected Windows user profile has no
`.wslconfig` override. NSS uses `hosts: files dns`.

No Cargo config/config.toml exists in the project, project-local Cargo home,
standard user Cargo home, inspected ancestor directories, or `/etc/cargo`.
There are no proxy or Cargo override environment variables in this process and no
user/system curlrc files. `/etc/environment` only sets PATH. Cargo errors reference
the standard index.crates.io and static.crates.io endpoints; there is no observed
custom registry, mirror, offline override or disabled TLS verification.

Windows' live system proxy, VPN and host firewall behavior cannot be established
from this restricted network namespace. HTTPS certificate validation was never
reached, so there is no evidence of a CA certificate problem. Browser research
uses a separate tool service and does not demonstrate local Cargo connectivity.

## Actual verification results

| Check | Result in this session |
| --- | --- |
| `cargo test --workspace --offline --locked` | PASS: PHOENIX 16, REWIND 62; 78 passed, zero failed or ignored; doc-tests 0 |
| `cargo build --workspace --tests --offline --locked` | PASS |
| `cargo fmt --all -- --check` | PASS |
| `cargo fmt --manifest-path integration-tests/Cargo.toml -- --check` | PASS; formatting only |
| `python3 scripts/diagnose-network.py` | Exit 2: Internet socket creation denied |
| `CARGO_NET_RETRY=0 RUSTFLAGS='--cfg near' cargo build --workspace --target wasm32-unknown-unknown --release --locked` | Exit 101: cannot fetch bumpalo 3.20.3; static.crates.io DNS failure |
| `CARGO_NET_RETRY=0 cargo test --manifest-path integration-tests/Cargo.toml -- --nocapture` | Exit 101 before compilation: index.crates.io/config.json DNS failure |
| Sandbox executable | Not installed or configured successfully |
| Fresh contract WASMs | Not produced; existing artifacts are not evidence of a current build |
| Sandbox deposits, one-time settlement, refunds, failed transfer callbacks and unauthorized payment rejection | Not executed; no sandbox pass claimed |

Existing native unit tests still cover deposit accounting, payment success,
settlement replay, unauthorized withdrawals, failed transfer reconciliation,
refunds, refund races, and uncertain outcomes. They do not establish validator
receipt ordering or real WASM callback gas costs. A failed *transfer* whose callback
successfully restores accounting is different from a permanently failed *callback*;
permanent callback failure remains a locked/uncertain outcome in the contract.

## Secure next steps outside this restricted session

First run the read-only diagnostic from a normal Ubuntu terminal:

```sh
cd /path/to/near-phoenix
python3 scripts/diagnose-network.py
```

If it succeeds there, WSL networking does not need a DNS repair. Continue the work
in an execution environment that permits outbound HTTPS and localhost TCP sockets.
No certificate bypass, resolver replacement, Windows interoperability workaround
or privilege workaround is necessary or appropriate for this session restriction.

If the normal terminal also fails, compare host and guest **before** changing DNS.
In a normal Windows PowerShell terminal:

```powershell
wsl --version
wsl --status
Resolve-DnsName index.crates.io
Test-NetConnection index.crates.io -Port 443
```

In Ubuntu, use `getent ahosts index.crates.io` and
`curl --disable --fail --head --connect-timeout 8 --max-time 15 https://index.crates.io/config.json`.
`--disable` ignores curlrc files; it does not disable certificate checks. If DNS
works but HTTPS fails, inspect the approved proxy/VPN and CA trust configuration
rather than disabling TLS verification.

DNS tunneling is already consistent with the observed configuration. Only if
outside-session checks establish a real WSL DNS tunneling problem, review the
existing `%UserProfile%\.wslconfig`, preserving all sections and settings. Setting
`dnsTunneling=true` under `[wsl2]` routes DNS through Windows' virtualization
interface; keep WSL-generated resolv.conf enabled. This is an explained optional
host fix, **not a change applied here**. Enable `autoProxy=true` only if Windows
actually requires an approved HTTP proxy. Do not copy public nameservers over
resolv.conf or weaken TLS/firewall rules. A WSL restart can interrupt every running
distribution; save work before applying any host change and restarting WSL.

After the normal terminal has working sockets, DNS and verified HTTPS:

```sh
cargo test --workspace --offline --locked
RUSTFLAGS='--cfg near' cargo build --workspace --target wasm32-unknown-unknown --release --locked
cargo test --manifest-path integration-tests/Cargo.toml -- --nocapture
```

The WASM target is already installed (rustc 1.99.1). Linux x86_64 is supported by
the official sandbox tooling, and the existing near-workspaces dependency enables
its installer by default. Dependency resolution must finish and produce the
integration workspace lockfile before that installer and the test APIs can be
validated. Retain the resulting lockfile, build output and real test results.

## Additional sandbox compatibility issue

The pinned SDK 5.30.0 locally declares `min_protocol_version = 88`. The
near-workspaces 0.23.0 release declares near-sandbox 0.3.12 as a dependency, whose
published default is nearcore 2.13.0 / protocol 86. Semver resolution could select
a later compatible near-sandbox library; without the integration lockfile, the
actual binary selection is unresolved. Do not assume that the default installed
binary meets SDK requirements just because it runs on Linux. Select and verify
an official sandbox binary and active genesis protocol supporting at least 88,
or review a compatible SDK/tooling combination and rerun all tests. No SDK downgrade,
unverified binary or claim of compatible sandbox installation was made here.

## References

- [Microsoft WSL configuration: DNS tunneling address and defaults](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)
- [Microsoft WSL networking: DNS tunneling and proxy behavior](https://learn.microsoft.com/en-us/windows/wsl/networking)
- [Official near-workspaces 0.23.0 dependencies and default install/TLS features](https://github.com/near/near-workspaces-rs/blob/near-workspaces-v0.23.0/workspaces/Cargo.toml)
- [Official near-sandbox 0.3.12 default binary / protocol](https://github.com/near/near-sandbox-rs/blob/v0.3.12/src/lib.rs)
- [Official NEAR Sandbox Linux platform requirements](https://github.com/near/near-sandbox-rs)

No public-network deployment or real funds were used.
