# Rust registry investigation and safe recovery

## Findings (2026-11-04)

- Cargo 1.99.1 uses libcurl 8.21.0-DEV with Schannel on Windows. Windows curl 8.22.0 also uses Schannel.
- Both fail HTTPS to index.crates.io/config.json and static.crates.io with AcquireCredentialsHandle / SEC_E_NO_CREDENTIALS (0x8009030e). Forcing TLS 1.2 produced the same failure and was not retained.
- DNS resolved the official registry host. The system clock was checked. CurrentUser and LocalMachine root stores were accessible and each contained 65 certificates. This checks availability, not an audit of every root certificate.
- No Cargo configuration files were found at the project, ancestor, or user locations inspected. No CARGO/RUST/proxy/custom-CA environment overrides were present. WinHTTP uses direct access and the Windows user static proxy is disabled. Git's installed configuration selects Schannel; it was not changed.
- Node.js fetched the registry configuration and near-sdk archive with HTTP 200. An HTTPS diagnostic to index.crates.io reported authorized=true and TLSv1.3, with a GlobalSign-issued server certificate valid through January 5, 2027. NODE_TLS_REJECT_UNAUTHORIZED was unset.

The evidence isolates the failure to native Schannel credential acquisition in this execution environment. It does not establish a damaged root store or justify replacing certificates. The exact OS/execution-context cause is not proven; native Cargo HTTPS remains unresolved. No system registry, certificate, proxy, security policy or global tool settings were changed.

## Working dependency path

scripts/cache-rust-dependencies.mjs downloads official sparse registry metadata using Node.js default certificate and hostname verification, populates only .cargo-local, resolves with Cargo offline when necessary, and downloads archives over verified HTTPS. Redirects and non-allowlisted hosts are rejected. The helper refuses NODE_TLS_REJECT_UNAUTHORIZED=0. It checks each package's registry checksum against Cargo.lock and checks each archive's SHA-256. Cargo subsequently consumes the official cached registry packages with --offline --locked, preserving the ordinary crates.io source identity; no alternate registry, HTTP mirror, trust override or TLS bypass is used.

The script uses Cargo's internal sparse cache format, tested with Cargo 1.99.1. Keep the lockfile and review the helper on Cargo upgrades. Cached archive corruption or registry/lockfile checksum disagreement fails closed. From the repository root, use the commands in README.md. The Node.js cache helper resolves dependency access for this project; it does not repair the system Schannel implementation.

## Compilation fixes

1. aws-lc-sys initially failed because NASM was unavailable. Set AWS_LC_SYS_PREBUILT_NASM=1 for the build process, selecting the crate's supported, shipped prebuilt Windows assembly objects. Cryptography and assembly remain enabled. No downloaded executable installer was run.
2. Initial offline resolution selected chrono 0.4.20, whose API could not compile near-primitives 0.38.0. Updated Cargo.lock to chrono 0.4.45 after retrieving its required metadata. No dependency source code was patched, no direct unused dependency was added, and no phoenix-core logic changes were required.

## References

- Cargo configuration lookup and TLS settings: https://doc.rust-lang.org/cargo/reference/config.html
- Cargo offline/locked operation: https://doc.rust-lang.org/cargo/commands/cargo-test.html
- Node.js TLS validation: https://nodejs.org/docs/latest-v22.x/api/tls.html
- AWS-LC Rust build requirements and prebuilt NASM support: https://aws.github.io/aws-lc-rs/requirements/windows.html
- Exact build-option implementation inspected locally: .cargo-local/registry/src/index.crates.io-1949cf8c6b5b557f/aws-lc-sys-0.47.0/builder/main.rs and builder/nasm_builder.rs
