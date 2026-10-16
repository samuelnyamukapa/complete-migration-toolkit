# Test plan

## Purpose

This plan says how we know the toolkit works, and how each pilot proves a phase is done. Agents help with the testing, but people keep the judgement: a phase is done only when a named person signs its pilot report.

Update this plan in the same pull request as any change to what a phase must prove.

## Levels

| Level | What it checks | Where | How it runs |
|---|---|---|---|
| Unit | Each part on its own: settings, cases, JSON paths, diff, contracts, drift, verdicts, HAR import, sign-off | `packages/*/test/*.test.mjs` | `npm test`, which uses Node's built-in test runner (`node --test`) |
| End to end | Both modes, the `cmtk` command and the MCP server, against local test servers | The same folders | `npm test` |
| Adapter conformance | It answers `describe`; each sample gives an observation, the same one twice; no header value leaks | `cmtk adapter check <name>` | In CI for the adapter template today, and for every adapter added in Phase 2 |
| Pilot | A real system, through the runbook, ending in a signed report | A pilot folder beside the system, never inside it | By a person, with agents helping |

Three rules for every test:

- A bug fix comes with a test that fails before the fix and passes after it.
- Tests reach only the local machine. CI holds no real keys and calls no real service.
- Every claim in the docs is backed by a test.

## What each phase must prove

| Phase | Scenarios | Evidence | Who signs |
|---|---|---|---|
| 0 | A planted difference in the billing fixture is caught, and nothing else. Done in modernize-for-copilot 1.1.1 | The `/modernize:parity` report | The owner |
| 0.1.1 ([#1](https://github.com/samuelnyamukapa/complete-migration-toolkit/issues/1)) | Each finding from the independent review has a test that fails before its fix | Green CI on Windows and Linux | A maintainer, reviewing the pull request |
| 1 ([#35](https://github.com/samuelnyamukapa/complete-migration-toolkit/issues/35)) | eShop: cases run on legacy; legacy compared with CatalogCore; the OpenAPI contract checked; a HAR imported with no secrets left; the runbook followed on Windows | Run and compare reports; a drift ledger where every entry names a person; the eShop checksum list unchanged | The person who accepts the pilot result |
| 1b ([#36](https://github.com/samuelnyamukapa/complete-migration-toolkit/issues/36)) | `/cmtk:plan` drafts checked against cases people wrote; `/cmtk:triage` on planted noise, drift and a defect; `/cmtk:explore` finds planted bugs; one real team for one sprint | Draft acceptance counts; a log of who made each triage decision; the sprint write-up | The team's test lead |
| 2 ([#37](https://github.com/samuelnyamukapa/complete-migration-toolkit/issues/37)) | Every adapter passes the conformance kit; a Windows service compared with its Worker Service rebuild; CardDemo batch outputs compared; someone outside the core team adds an adapter in a day | Conformance results; the pilots' compare reports | The pilot owner. A maintainer raises an adapter's level |
| 3 ([#38](https://github.com/samuelnyamukapa/complete-migration-toolkit/issues/38)) | eShop journeys on a reskin and on a new front end; structure comparison; one desktop journey; an MFA login with a test authenticator; replay with no model calls | Journey reports; screenshots kept as evidence; the model-call count, which must be zero in CI | The pilot owner |
| 4 ([#39](https://github.com/samuelnyamukapa/complete-migration-toolkit/issues/39)) | Shadow traffic for an agreed period; nightly trend reports; `npx cmtk` on clean machines; every migration mode proven on a pilot | A signed report for each mode; the trend report | The pilot owner for each mode. A maintainer tags the release |

## Safety tests that must always pass

These run in CI on every pull request, except the last two, which start with the phase that adds payment and messaging adapters (Phase 2) and with each pilot. A pull request that breaks one is not merged.

- **Changing data needs two switches.** POST, PUT, PATCH and DELETE are skipped unless `allow_unsafe_methods: true` is in `cmtk.yaml` and `--allow-unsafe` is on the run. Each switch is tested on its own: the request must not be sent.
- **Secrets never reach disk.** A test plants a known secret in `headers_from_env` and searches every file the run wrote.
- **HAR import keeps credentials out.** It drops cookies and authorization, key and token headers, and redacts secret-looking query values and body fields.
- **Requests go only to the targets in `cmtk.yaml`.** A case holds a path, never a host.
- **Redirects are compared, not followed.**
- **No proxies.** Requests go straight to the target, even when proxy environment variables are set.
- **Only a person signs.** `cmtk signoff` refuses to run without a terminal, and the MCP server has no sign-off tool. A sign-off is tied to the evidence it covers, and a NO EVIDENCE report can't be signed.
- **Evidence stays inside the project.** Clearing old evidence never follows a link outside it.
- **Sandboxes only for money and messages.** Payment adapters refuse live keys, such as `sk_live_`, before any network call. Email and SMS adapters refuse anything that isn't a capture server or a test number.
- **Pilot systems are never modified.** Each pilot checks the system's folder against a checksum list before and after every session.

## Platforms

- CI runs `npm test` on Windows and Linux for every push and pull request.
- The toolkit needs Node 22.5 or later.
- Windows gets its own checks: drive letters, spaces in paths, long paths, Windows line endings (CRLF), PowerShell environment variables, and file names Windows reserves. See [#7](https://github.com/samuelnyamukapa/complete-migration-toolkit/issues/7).
- Pilots run where the system runs: eShop on Windows.

## How to report a test gap

If something isn't tested, open an issue with the [test gap template](https://github.com/samuelnyamukapa/complete-migration-toolkit/issues/new?template=test-gap.md). Say what isn't covered, what could go wrong, and suggest a case.

For a fault in cmtk, use the [bug template](https://github.com/samuelnyamukapa/complete-migration-toolkit/issues/new?template=bug.md). For a dependency no adapter can test yet, use the [adapter request template](https://github.com/samuelnyamukapa/complete-migration-toolkit/issues/new?template=adapter-request.md).
