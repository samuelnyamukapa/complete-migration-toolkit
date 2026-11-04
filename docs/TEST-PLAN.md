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
| 2 ([#37](https://github.com/samuelnyamukapa/complete-migration-toolkit/issues/37)) | Every adapter passes the conformance kit; a Windows service compared with its Worker Service rebuild; CardDemo batch outputs compared; someone outside the core team adds an adapter in a day, installed from a registry and passing the kit, using [the guide](ADAPTER-CONTRIBUTING.md) alone | Conformance results; the pilots' compare reports | The pilot owner. A maintainer raises an adapter's level |
| 3 ([#38](https://github.com/samuelnyamukapa/complete-migration-toolkit/issues/38)) | eShop journeys on a reskin and on a new front end; structure comparison; one desktop journey; an MFA login with a test authenticator; replay with no model calls | Journey reports; screenshots kept as evidence; the model-call count, which must be zero in CI | The pilot owner |
| 4 ([#39](https://github.com/samuelnyamukapa/complete-migration-toolkit/issues/39)) | Shadow traffic for an agreed period; nightly trend reports; `npx cmtk` on clean machines; every migration mode proven on a pilot | A signed report for each mode; the trend report | The pilot owner for each mode. A maintainer tags the release |

## Safety tests that must always pass

These run in CI on every pull request, except the last one, which starts with each pilot. A pull request that breaks one is not merged.

- **Changing data needs two switches.** POST, PUT, PATCH and DELETE are skipped unless `allow_unsafe_methods: true` is in `cmtk.yaml` and `--allow-unsafe` is on the run. Each switch is tested on its own: the request must not be sent. So is a read that asks to be something else: a method-override header, `_method`, `_HttpMethod` or `method=DELETE` in the query or after a `;`, and a body on an HTTP read.
- **`safe: true` is the one exception, and a person sees it.** The mark alone does nothing: the case still needs both switches, and an adapter is not told it. It counts only when `cmtk review` recorded a person who saw that case on its own, with a warning. Bulk accept leaves it out. The confirmation holds a fingerprint of the request and of any file the case sends or plays, so changing them ends it. `cmtk check` warns about a mark nobody confirmed.
- **Secrets never reach disk.** A test plants a known secret in `headers_from_env` and searches every file the run wrote.
- **HAR import keeps credentials out.** It drops cookies and authorization, key and token headers, and redacts secret-looking query values and body fields.
- **A recording is not a requirement.** `cmtk import-har --draft-expect` copies only the status and the media type of a recorded answer, never body text or another header. The case is skipped until a person confirms that expectation, one at a time, in `cmtk review`.
- **Shadow traffic only reads.** `cmtk shadow` sends only GET, HEAD and OPTIONS. It drops and counts anything else, a body on a read, and a method override. A test plants them, and neither system may receive one.
- **Shadow traffic stores nothing personal.** Planted credentials and personal data in a log must not reach any file written, what is sent, or what is printed. Answers are not kept, and differing values are withheld. A clean replay never reads as parity.
- **Requests go only to the targets in `cmtk.yaml`.** A case holds a path, never a host.
- **Redirects are compared, not followed.**
- **No proxies.** Requests go straight to the target, even when proxy environment variables are set.
- **Only a person signs.** `cmtk signoff` refuses to run without a terminal, and the MCP server has no sign-off tool. A sign-off is tied to the evidence it covers, and a NO EVIDENCE report can't be signed.
- **Only a person installs an adapter.** `cmtk adapter add` refuses to run without a terminal and has no flag to skip the question. The MCP server has no install tool. Nothing from the adapter runs during an install, the version is pinned, and links, submodules and addresses holding a credential are refused.
- **A read changes nothing.** `cmtk compare` resets a system only before a case that writes and is really sent. Two different states read through a GET are NO PARITY, and both are left as they were. An adapter gets a reset before reads only by asking in `describe`. A test runs this on the SMS adapter, the worker adapter and a stand-in.
- **A case with no adapter is never a pass.** Nothing is sent for it, it counts as an error, and the report names it.
- **Only a person adds a known issue.** The ledger refuses an entry with no named person, or one naming an agent. An agent's proposal changes no verdict until a person accepts it in `cmtk review`. A failure the entry does not describe is still FAIL, and a known issue never counts as passed.
- **Part of a system never reads as parity.** When a target lacks a surface, or a surface a target lists has no case, the verdict is PARTIAL COMPARISON at best, with exit code 4, and the report and the signature state the scope. Nothing is sent for a case that is not comparable.
- **Sandboxes only for money and messages.** Payment adapters refuse live keys, such as `sk_live_`, before any network call. Email and SMS adapters refuse anything that isn't a capture server or a test number. See `adapters/*/test/safety.test.mjs`.
- **A cut answer never reads as a pass.** An answer over 5 MB is read only up to that limit, so the verdict is INCOMPLETE for `cmtk run` and `cmtk shadow`, and PARTIAL COMPARISON at best for `cmtk compare`.
- **Evidence stays inside the project.** Clearing old evidence never follows a link outside it. That includes `cmtk trend clean`: a test points links at files outside, at every level of the history, and they must survive.
- **A browser only does what the case allows.** A case written as GET, HEAD or OPTIONS only reads: the web adapter's browser refuses every write and reports it. A journey that writes is written as POST, so both switches apply. The browser reaches only the target's own address and uses no proxy.
- **Page text is data.** A journey's steps and checks come from its file. Page text only goes into values, and an instruction written on a page changes nothing.
- **Passwords come from the environment.** A step that types into a password field with a value written in the file is refused, and no value from `with_env` or a header appears in an answer.
- **A TOTP seed stays in its environment variable.** A test plants a seed, runs an MFA journey on two systems, and searches every file the run wrote, standard output and standard error for the seed and the codes.
- **A repair never changes what is expected.** A broken locator is an error, and it stays one until a person accepts a proposal. The proposal can only change how an action step finds its element, on one target, and refuses a read, a check or an `expect:` block.
- **Replay makes no model calls.** A test replays a script with the model keys removed and every non-local connection recorded, and the report shows zero.
- **A desktop app runs only where it is meant to.** The real reader refuses a target without `isolated_vm: true`, and a step marked `leaves_sandbox` needs a named person who is not an agent. A case written as GET cannot press or fill anything. On a system with no Windows UI Automation, the adapter says so, and only an app written as a stub runs.
- **Evidence stays inside the project.** Clearing old evidence never follows a link outside it.
- **Sandboxes only for money and messages.** Payment adapters refuse live keys, such as `sk_live_`, before any network call. Email and SMS adapters refuse anything that isn't a capture server or a test number.
- **Pilot systems are never modified.** Each pilot checks the system's folder against a checksum list before and after every session.

## Platforms

- CI runs `npm test` on Windows and Linux for every push and pull request.
- The toolkit needs Node 22.5 or later.
- Windows gets its own checks: drive letters, spaces in paths, long paths, Windows line endings (CRLF), PowerShell environment variables, and file names Windows reserves. See [#7](https://github.com/samuelnyamukapa/complete-migration-toolkit/issues/7).
- Pilots run where the system runs: eShop on Windows.

## Limits and formats

`packages/core/test/limits.test.mjs` tests the performance limits in [FORMATS.md](FORMATS.md). `packages/cli/test/formats.test.mjs` checks the examples and real output against the JSON Schemas in `schemas/`, and FORMATS.md's lists against the code.

## How to report a test gap

If something isn't tested, open an issue with the [test gap template](https://github.com/samuelnyamukapa/complete-migration-toolkit/issues/new?template=test-gap.md). Say what isn't covered, what could go wrong, and suggest a case.

For a fault in cmtk, use the [bug template](https://github.com/samuelnyamukapa/complete-migration-toolkit/issues/new?template=bug.md). For a dependency no adapter can test yet, use the [adapter request template](https://github.com/samuelnyamukapa/complete-migration-toolkit/issues/new?template=adapter-request.md).
