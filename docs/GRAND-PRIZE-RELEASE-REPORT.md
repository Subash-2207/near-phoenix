# NEAR PHOENIX — Grand Prize release preparation

**Review date:** 2026-11-09<br>
**Status:** Local release candidate prepared; not committed, pushed, published,
or submitted. The approved UI was frozen during this review.

## Git and preservation

At the start of the Nov 9 review, the repository was on `main` at `387b6f6` with
98 reported working-tree paths and no Git remote. The urgent audit finds 45
modified tracked files and 42 actual nonignored untracked files (31 status
entries because directories group assets); none are staged. The uncommitted
implementation and documentation are preserved. No contract or wallet
authorization code was changed by these release checks. The requested tests
deployed contracts and signed transactions only inside disposable local NEAR
Sandbox. There was no mainnet deployment, user-wallet connection/approval,
public transaction, or real-fund operation.

The only functional code-adjacent correction in this pass was a quoting fix in
`scripts/demo-local.sh`'s final status message. Its prior unmatched quote made
the wrapper return nonzero after the demo had succeeded. The file was backed up
to `/tmp/phoenix-demo-local.sh-before-quote-fix-20261109`; `bash -n` now passes
and the complete command exits zero. Seventeen modified text files had their
CRLF line endings normalized to LF; no visual, protocol, or financial behavior
was changed. Final `git diff --check` and local Markdown-link checks pass.

Local timestamped backups are ignored by `.gitignore` and remain on disk. Do not
include `.phoenix-design-backups/` or `*.backup-*` in a public source archive.

The working copies of four historical documents have had the local checkout
path generalized to `/path/to/near-phoenix`. Both existing Git commits still
contain that path, so the public candidate must use a fresh, single-snapshot
repository rather than inherit the local history. The original `main` history
remains untouched. A follow-up scan found no private-key/token patterns, local
credential files or contact details. The test for rejecting URL credentials
now assembles its dummy username/password at runtime, so no credential-shaped
URL is stored in source.

A clean-history candidate is staged at
`/tmp/near-phoenix-grand-prize-ready-oc7la7k7`. It contains exactly 165 paths
from [the staging list](release-stage-paths.txt), has no commit or remote, and
uses an empty Git history so the old checkout path is not published. The
original `main` worktree and index remain unstaged. The 12 PNG assets are in the
candidate index but must not be committed until the rights holder confirms
redistribution permission.

## Wallet-signing review

The NEAR Connect instance uses `autoConnect: false`; connection alone does not
call a signing method. Its feature list includes `signAndSendTransaction`, so
the connector can support the optional workbench. Backend readiness is false
when `PHOENIX_ENABLE_WALLET_ACTIONS` is unset or false; both example network
configs set it to false. Mainnet additionally requires
`PHOENIX_ENABLE_MAINNET_ACTIONS=reviewed`. If explicitly enabled, the backend
prepares only `heartbeat` or `report_crash`, with zero attached deposit, a 30
Tgas cap, pinned code hash and finalized-state checks. The client rechecks the
plan/session and requests explicit wallet approval. No automatic signing or
additional action was found, and no signing permission was enabled during this
review. Do not describe the optional enabled flow as read-only.

## License and distribution scope

No prior project license or source license header was found. npm and Cargo
dependencies are referenced but not vendored, and retain their own upstream
licenses. A standard MIT grant has been prepared for original project source
and documentation only, with exclusions for dependencies, artwork and marks.
The 12 dashboard PNGs have no embedded license metadata or recorded provenance;
the rights holder must confirm redistribution authority before publication.
The visible official event page does not list a license requirement. The
downloadable `HACKATHON.md` could not be retrieved because the review tool
rejects its `text/markdown` content type, so confirm any extra terms directly.

## Validation results

The complete command `CARGO_NET_OFFLINE=true bash scripts/test-phase6.sh`
passed after granting the local NEAR Sandbox processes the socket access they
need. A restricted run without that access failed the five Sandbox cases before
scenario setup; the elevated rerun passed all five.

| Area | Result |
| --- | --- |
| Rust formatting | **PASS** — contracts, recovery service, and integration crate. |
| PHOENIX Core and REWIND unit tests | **PASS** — 145 total (53 Core, 92 REWIND). |
| Recovery service and worker | **PASS** — 56 service tests and 1 real worker-process crash/restore test. |
| Backend | **PASS** — all 5 configured Node test files (37 cases), including receipt/replay coverage; rerun after the URL-credential fixture was made nonliteral. |
| TypeScript | **PASS** — backend and dashboard. |
| Dashboard wallet tests | **PASS** — 4/4. |
| Dashboard evidence and recovery transitions | **PASS**. |
| Phase 8B evidence-classification tests | **PASS** — 5/5. |
| NEAR Sandbox integration | **PASS** — 5/5, ephemeral local accounts and contracts, 102.95 seconds in the full run. |
| Optimized contract WASM and import audit | **PASS** — Core 278,665 bytes / 15 reviewed imports; REWIND 237,980 bytes / 25 reviewed imports. |
| Dashboard production build | **PASS** — 13 static routes generated. |
| Fresh `npm audit` | **PASS** — 0 findings across 70 resolved packages. |
| Browser screenshots / hydration / console | **BLOCKED** — Chromium is cached, but cannot start without `libnspr4`, `libnss3`, and `libasound2`; this environment has no root access to install them. |

## Unified demonstration and receipt evidence

The corrected `npm run demo:local` was rerun successfully in local NEAR Sandbox:

- `POST /api/demo` returned 202; final `GET /api/demo` returned 200.
- The child process exited 0 and the backend status was `succeeded`.
- The fresh artifact contained 12 events, one settlement, one duplicate-payment
  prevention event, and one signed recovery-receipt event.
- The receipt's settlement reference matched the single settlement operation;
  its checkpoint digest matched the committed checkpoint, and its evidence
  fields matched the receipt body.
- The fresh artifact was re-opened after the run: status `succeeded`, child exit
  code 0, Sandbox receipt domain, nonempty signed receipt, one settlement and
  one receipt, with the settlement operation and checkpoint bindings matching.
- The generated artifact is
  `/tmp/near-phoenix-phase7b-demo-20261109T095720Z-3129884.json`.

This is genuine execution and receipt-signature evidence within the disposable
Sandbox harness. The backend verifies the signature and bindings against the
scenario events. It is **not** an independently verified NEAR light-client or
transaction execution proof. The Phase 8B tests specifically reject treating a
self-asserted `on_chain_verified` field as such proof; transaction, receipt,
causal-link, and finality proof material remains incomplete. Do not describe the
artifact as an independently verified cryptographic NEAR proof or a mainnet
receipt.

## Secret and sensitive-file check

No `gitleaks` or `trufflehog` executable was installed. A local redacted
pattern scan covered current text files, hidden backup files, and both reachable
Git snapshots for private-key PEM blocks, common GitHub/AWS/live API tokens,
NEAR-format secret keys, and high-entropy credential assignments. It reported
no matches. A filename scan found no `.env`, `.pem`, `.key`, `.seed`, or
`near-credentials.json` files; only documented environment examples are
present. No Git remote is configured, so there is no credential-bearing remote
URL. The scan prints paths and detector classes only and never prints matched
values.

This is a pattern scan, not a guarantee that no sensitive data exists. Review
the final public file list and the uncommitted additions manually before
publication. Keep `.aws/`, local NEAR credentials, local environment files,
backups, caches, and generated build output out of GitHub.

## Submission materials prepared

**Project description draft** (within the current form's 20–2,000 character
range):

> NEAR PHOENIX is a local-first recovery prototype for autonomous agent tasks. A deterministic worker signs heartbeats and checkpoints; after failure, a coordinator requests independent SENTINEL approval, restores an authorized backup under a new PHOENIX fencing epoch, and settles a task-bounded REWIND escrow operation once. GUARDIAN records and quarantines unauthorized attempts. The demonstration uses disposable NEAR Sandbox accounts only. The receipt is signed and backend-validated against scenario evidence, not an independently verified NEAR light-client proof.

**Two-minute demonstration:** [docs/demo-script.md](demo-script.md). It uses the
current event sequence and tells presenters to show the fresh JSON artifact and
state the proof limitations.

**X post draft — not published:**

> Built at NEAR HACKATHON: NEAR PHOENIX demos bounded agent recovery: signed checkpoints, SENTINEL approval, fenced backup restore, one Sandbox settlement and GUARDIAN quarantine. Sandbox only; receipt is backend-validated, not independent NEAR proof. @NEARProtocol #NEARHackathon

Attach the unedited video or screenshots to this post. Add its public URL to
the form; the post has not been published.

**Track recommendation:** AI Security & Defense (primary); Agent Economy
(secondary). The live [NEAR Hackathon submission page](https://nearhackathon.com/)
lists a deadline of 2026-11-14 23:59 UTC and requires a public repository, a
public X post saying it was built at NEAR HACKATHON, tags `@NEARProtocol` and
`#NEARHackathon`, and video or screenshots. The form requires project name,
team lead, email, team size, track(s), a NEAR payout address, public repository
URL, public demo post URL, a 20–2,000 character description, consent and an
optional website. Recheck the page before submission.

## GitHub handoff commands

The clean candidate has already been initialized and staged locally. Review it
without changing the source repository:

```sh
candidate=/tmp/near-phoenix-grand-prize-ready-oc7la7k7
git -C "$candidate" status --short --branch
git -C "$candidate" diff --cached --check
git -C "$candidate" diff --cached --stat
```

After confirming the license holder and PNG redistribution rights, create an
**empty public** GitHub repository (do not initialize it with a README/license),
then, only after explicit approval to publish:

```sh
git -C "$candidate" config user.name "YOUR GIT AUTHOR NAME"
git -C "$candidate" config user.email "YOUR GIT AUTHOR EMAIL"
git -C "$candidate" commit -m "Prepare NEAR PHOENIX v5.0 hackathon submission"
git -C "$candidate" remote add origin https://github.com/OWNER/REPOSITORY.git
git -C "$candidate" remote -v
git -C "$candidate" ls-remote --heads origin
```

If `ls-remote` shows an existing branch, stop and do not force-push. Only when
the remote is the intended empty public repository and publication is approved:

```sh
git -C "$candidate" push -u origin main
```

Do not put a GitHub token in a URL or source file. The repo push, X post and
hackathon form are separate external actions and each still requires approval.

## Remaining blockers and exact actions

1. **Confirm the MIT rights holder and art redistribution rights.** Confirm
   ownership/authorization for original source and the 12 dashboard PNGs.
2. **Complete browser QA and recording.** Use
   [the Windows Chrome checklist](browser-qa-windows.md) and capture the actual
   running app. The concept MP4/HTML prototype are not live recordings.
3. **Review the clean staged snapshot.** Inspect
   [the exact staging list](release-stage-paths.txt), approve all assets, and
   review the candidate index before creating a local commit.
4. **Connect GitHub.** No remote is configured. Use an empty public repository
   and the fresh-history candidate; never force-push over an existing repo.
5. **Fill the live submission form.** The team lead, email, team size, payout
   NEAR account, public repository URL, public X post URL, and consent are not
   supplied in this workspace. The description and track choice above are
   drafts only.
6. **Keep proof claims scoped.** The Sandbox receipt is backend-validated
   application evidence. Independent finalized transaction/execution-proof
   verification remains unimplemented.
7. **Obtain explicit approval before each external action.** Publish the repo,
   publish the X post, and submit the form only after the owner approves them.
   None of these actions has been taken.
