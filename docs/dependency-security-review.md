> Historical report: the wallet dependency tree described below is superseded by the NEAR Connect migration. See wallet-integration.md for the current audit, workflow and remaining verification limits.

## Current release-candidate status (2026-11-09)

The fresh `npm audit` against the current workspace lockfile reports **0 known
vulnerabilities across 70 resolved packages**. This supersedes the historical
18-entry Wallet Selector audit recorded below; it is a dependency-database
snapshot, not an independent security review.

The current uncommitted dashboard also contains an operator workbench that can
request wallet signatures for exactly two bounded Core calls: `heartbeat` and
`report_crash`. This supersedes the historical statement below that the app
does not invoke transaction signing. The workbench rechecks the plan and wallet
session, uses zero attached deposit, limits gas, and requires explicit wallet
approval. Example network configurations leave wallet actions disabled;
mainnet additionally requires the explicit reviewed-actions flag. This path
has not been exercised with a real wallet or a live deployment in this release
check. It does not expose escrow settlement, transfer, withdrawal, deployment,
or recovery authorization. See [wallet integration](wallet-integration.md) and
the [Grand Prize release report](GRAND-PRIZE-RELEASE-REPORT.md).

No production security claim follows from the npm audit result. Review the
exact wallet code, package lock and live configuration before publishing.

# Dependency security review

Review date: 2026-11-05

## Scope and evidence

The normal Ubuntu `npm audit fix --dry-run` report supplied for this review lists
18 vulnerable package entries: 5 high and 13 low. The entries include
transitive packages and repeat shared advisories through the installed
dependency tree. In this environment, a fresh `npm audit` could not reach
`https://registry.npmjs.org/` because DNS resolution returned `EAI_AGAIN`.
Therefore the counts below reproduce the supplied report and are not a fresh
registry audit.

The dashboard currently pins `@near-wallet-selector/core`,
`@near-wallet-selector/modal-ui`, and
`@near-wallet-selector/meteor-wallet` to 10.1.4. Its installed Meteor adapter
uses `@meteorwallet/sdk` 1.0.24, `near-api-js` 6.5.1, `@near-js` 2.2.5 through
2.5.1, `nanoid` 5.1.5, `query-string` 7.1.3, and `decode-uri-component` 0.2.2.
The tree also contains `nanoid` 3.3.20 from the Next/PostCSS path, `secp256k1`
5.0.1, and `elliptic` 6.6.1.

## Distinct advisories and exposure

| Advisory | Installed vulnerable dependency | Available patch noted by advisory | PHOENIX reachability |
|---|---|---|---|
| [GHSA-vcc3-ghjq-m6fr / CVE-2026-45822](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr) | `decode-uri-component` 0.2.2; affected through 0.4.2 | 0.5.0 fixes the exponential-decoding issue | `query-string` uses this package for parsing. Meteor SDK's inspected browser code calls `stringify` when creating a wallet popup URL; PHOENIX does not call the parser in its current connection flow. |
| [GHSA-qr28-fpjm-wq7f / CVE-2026-118664](https://github.com/advisories/GHSA-qr28-fpjm-wq7f) | `decode-uri-component` 0.2.2; affected through 0.5.0 | 0.5.1 fixes the quadratic replacement issue, including the regression left in 0.5.0 | Same dependency and current call path as above. The affected parser remains installed and could become reachable if a parser path is used with untrusted input. |
| [GHSA-28wg-ghj8-5hjv / CVE-2026-67214](https://github.com/advisories/GHSA-28wg-ghj8-5hjv) | SDK's `nanoid` 5.1.5; the other copy is 3.3.20 | 5.1.16 for 5.x; 3.3.16 for 3.x | SDK calls `nanoid()` without an explicit size. The issue requires attacker-controlled size input to its non-secure/custom generator path; PHOENIX does not supply such a value. |
| [GHSA-2v37-7h3g-55p8 / CVE-2026-67213](https://github.com/advisories/GHSA-2v37-7h3g-55p8) | SDK's `nanoid` 5.1.5; the other copy is 3.3.20 | 5.1.6 for 5.x; 3.3.18 for 3.x | SDK's default `nanoid()` call does not provide the zero size required to trigger this issue. |
| [GHSA-xwg4-73v4-xw9w / CVE-2026-73086](https://github.com/advisories/GHSA-xwg4-73v4-xw9w) | SDK's `nanoid` 5.1.5; the other copy is 3.3.20 | 5.1.11 for 5.x; 3.3.12 for 3.x | The overflow issue requires a user-influenced size. PHOENIX's inspected call uses the default size. |
| [GHSA-848j-6mx2-7j84 / CVE-2025-14505](https://github.com/advisories/GHSA-848j-6mx2-7j84) | `elliptic` 6.6.1, via `secp256k1` and `@near-js/crypto` | No patched version is listed | The dependency is in the browser wallet stack and includes signing-capable code. PHOENIX itself does not invoke wallet signing or transaction methods. Treat signing as unavailable until this crypto path is removed or an upstream fix is verified. |

The report's `@meteorwallet/sdk`, Meteor Selector, `near-api-js`, `@near-js/*`,
`secp256k1`, and `query-string` rows are dependency-tree rollups of the
advisories above, not distinct additional advisory IDs. `@near-js/*` low
findings in this report trace through `secp256k1` to `elliptic`.

## Remediation assessment

- Do not accept `npm audit fix`'s proposed Meteor Selector 9.3.0 downgrade.
  It is a major-version downgrade from the project’s 10.1.4 stack and is not a
  verified security remediation. The official Wallet Selector repository
  continues to list its Meteor adapter. Keep 10.1.4 until a compatible,
  registry-verified update is tested.
- `nanoid` 5.1.16 is the smallest plausible SDK remediation for all three
  reported 5.x advisories. The SDK pins 5.1.5 exactly, so this requires a
  scoped override or an SDK release. Neither option was changed because
  registry access was unavailable and the changed package/lockfile could not
  be verified or retested.
- `query-string` 9.5.x uses the patched decoder range, but is ESM-only. A
  targeted change needs to prove compatibility with Meteor SDK 1.0.24 and the
  Next client build. An override of `decode-uri-component` across the declared
  0.2 range would be semver-incompatible and was not applied.
- Updating `@near-js/*` to the newest release would not by itself remove the
  `elliptic` advisory: the installed `@near-js/crypto` 2.5.1 still depends on
  `secp256k1` 5.0.1, which includes `elliptic` 6.6.1. Do not force a crypto
  override. A change to this cryptographic path must be supported upstream and
  verified with wallet compatibility tests.
- HOT Connect is a possible future connector evaluation: NEAR ecosystem
  material describes isolated wallet iframes and Wallet Selector-compatible
  APIs, while the NEAR GitHub organization lists Wallet Selector as a legacy
  integration tool. It is not adopted here: the repository's currently
  working Meteor connection is explicitly being preserved, and a connector
  switch needs its own source, permissions, network-verification and build
  review.

## Signing boundary and current result

Dashboard source was checked for `signAndSendTransaction`, `signTransaction`,
`signMessage`, and `requestSign` calls. The app uses the Selector only to open
the connection UI, read accounts, observe network changes, and sign out. It
does not submit blockchain actions. No signing or transaction controls should
be added until the `elliptic` path and the parser/generator dependency findings
have been resolved and retested. Wallet connection does not make any transaction
verified or authorized by PHOENIX.

No package manifests or lockfiles were changed in this review. The current
report's 18 findings remain unresolved; absence of a trigger in the current
read-only flow reduces demonstrated reachability but does not clear vulnerable
code from the installed/bundled wallet dependency graph.

## Validation

The recorded local validation for this review is:

- Backend tests: 4 passed.
- Wallet-session test: 1 passed.
- Backend/dashboard TypeScript checks: passed.
- Dashboard production build: passed.
- Fresh npm audit: unavailable due registry DNS `EAI_AGAIN`.

These checks are not a cryptographic audit or a claim that the dependency
vulnerabilities are fixed.
