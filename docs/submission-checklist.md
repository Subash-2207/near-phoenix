# Hackathon submission checklist

## Prepared locally

- [x] Judge-facing root README with architecture, feature status and local test/demo commands.
- [x] Phase 7, 7B, 8 and 8B reports retained with implementation/evidence limits.
- [x] Current release validation report with pass/fail matrix.
- [x] Two-minute demo narration and recording plan.
- [x] Windows Chrome desktop/mobile QA checklist.
- [x] Exact file inventory for a clean, new-history release snapshot.
- [x] Local Sandbox demo command that exports fresh run evidence under `/tmp`.
- [x] Secret-pattern scan of workspace and committed history; see release report for its scope.
- [x] Project description, short pitch, X draft, track recommendation and evidence list in the release report.

## Still required before public release or submission

- [ ] Review the current uncommitted worktree carefully. It includes existing
  implementation changes as well as release documentation. No changes have been
  committed or pushed by this release-preparation pass.
- [ ] Confirm the MIT copyright holder and that project contributors have
  authority to license all original source. The license explicitly excludes
  dependencies and artwork.
- [ ] Confirm the project has rights to redistribute the 12 dashboard PNGs;
  their provenance is not recorded in the repository and they have no embedded
  license metadata.
- [ ] Confirm any additional terms in the official downloadable `HACKATHON.md`;
  the review tool could not retrieve its `text/markdown` response.
- [ ] Configure the intended public GitHub remote and decide the release branch.
  No remote is currently configured; a fresh-history release snapshot is
  prepared locally, with no commit or tag created.
- [ ] Decide whether to publish this repository and obtain explicit owner
  approval before changing visibility or pushing anything.
- [ ] Capture and review an unedited browser recording of the dashboard flow.
  The terminal Sandbox demo is reproducible, but browser-based verification and
  a video capture were unavailable in this environment. Use
  [the Windows Chrome checklist](browser-qa-windows.md).
- [ ] Re-run the full validation and the one-command demo on the presentation
  machine if it differs from the environment recorded in
  [the release report](GRAND-PRIZE-RELEASE-REPORT.md).
- [ ] Confirm the official form fields, tracks, public repo URL, public X demo
  URL, project description, team information, payout NEAR address and consent.
  Do not place private keys or recovery phrases in source or evidence.
- [ ] Review source attribution, notices and the exact public file set. Do not
  publish credentials, local keys, build outputs, private files or the unreviewed
  design backup directory.
- [ ] Obtain separate explicit approval before publishing the repository,
  publishing an X post, or sending the hackathon application. None has been done.
- [ ] Do not make production-security claims without a professional independent
  audit and closure of the blockers in [security limitations](security-limitations.md).

Track recommendation: **AI Security & Defense** as primary and **Agent Economy**
as secondary. See the official current rules linked from the release report.

As checked on 2026-11-09, the official submission page lists a deadline of
2026-11-14 23:59 UTC and requires a public repository plus a public X demo post
with video or screenshots. Confirm the live page again before submission.

## Submission form fields

- [ ] Project name: `NEAR PHOENIX v5.0`.
- [ ] Team lead, email address and team size.
- [ ] Track(s): **AI Security & Defense** and, if desired, **Agent Economy**.
- [ ] NEAR payout account (the form does not require a wallet connection).
- [ ] Public GitHub repository URL.
- [ ] Public X post URL containing the demo video or screenshots.
- [ ] Project description, 20–2,000 characters; use the accurate draft in the
  [release report](GRAND-PRIZE-RELEASE-REPORT.md).
- [ ] Optional website URL.
- [ ] Consent checkbox.
- [ ] Submit once per project before the official deadline. Keep a copy of the
  confirmation and do not submit until the repository and X post are public.
