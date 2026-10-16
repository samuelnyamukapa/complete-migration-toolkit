# Changelog

## 0.1.2 (2026-10-16)

Fixes from the first pilot, on the eShop sandbox. The write-up is [docs/pilots/eshop.md](docs/pilots/eshop.md).

### Added

- **Targets reached only through an adapter.** A target can leave out `base_url` and give settings instead, such as `{ probe: probes/legacy.exe }`. Adapters receive them in `target`. An HTTP case on such a target is an error that says why.
- **The eShop pilot as a worked example** in `examples/eshop-pilot`:
  - its cases;
  - an adapter that compares a .NET Framework assembly with its .NET 8 rebuild through one C# probe;
  - the Windows scripts that ran it.

### Fixed

- Node 22 versions before 22.17 no longer print an "ExperimentalWarning" on every command.
- Imported HAR cases record the file's name, not the folder it was in.
- The runbook covers the pilot's Windows problems: a broken `npm` command, a `git pull` permission error, and imported cases replaying the browser's `Accept` header.

### Verified

- 41 tests on Windows and Linux.
- On the pilot machine (Windows 10, PowerShell 5.1, Node.js 22.14), each of these worked:
  - a case file with Windows line endings;
  - a folder name with a space, and a relative `--manifest`;
  - a 292-character evidence path;
  - credentials from `$env:`;
  - sign-off refusing piped input;
  - the MCP server driven by a Windows client.

## 0.1.1 (2026-10-16)

Fixes from an independent review of 0.1.0. Every fix has a regression test (`packages/core/test/review.test.mjs`).

### Fixed

- **Long or endless answers.** The whole answer must now arrive within `timeout_s`, so a streaming endpoint no longer hangs a run. Reading stops at 5 MB, counted after decompression, so a compressed answer cannot exhaust memory.
- **One bad case no longer ends a run.** An invalid header value, a missing adapter program, a failed reset or an invalid `matches` pattern now makes that case an error, and the run goes on.
  - Problems with the settings stop the run before any evidence is touched: an unknown surface, a token with a stray newline, or a bad scrub rule.
  - The evidence is replaced only once a run has finished.
- **HAR import leaves out far more credentials.** Headers that carry keys or tokens (such as `X-API-Key` and `X-Functions-Key`) are dropped. Credential-like values in query strings and request bodies become `REDACTED`, in JSON, forms, and XML or SOAP elements, attributes and CDATA. The rest of the body is kept exactly, numbers included. The command lists the cases to fill in. A credential under an unusual name can still get through, so read imported cases before committing them.
- **The diff misses less.**
  - Only an object's own keys are compared.
  - Key order is kept as sent, including keys that look like numbers.
  - Numbers keep every digit, also at `semantic`.
  - Bytes that are not UTF-8 are kept exactly, and a change of encoding is reported at `exact`.
  - In XML, moved mixed content and leading or trailing spaces in a value are differences at `exact`.
  - Long values that differ near the end show where they differ.
- **Every `where` can be approved as drift:** XML positions such as `Item[2]`, and JSON keys with quotes.
- **Contracts are locked, as the plan says.** Every contract change, additions included, needs a drift entry (`contract:<name>: <finding>`). Breaking changes can now be approved too.
- **Verdicts.**
  - A run with `--only` can no longer PASS: it is INCOMPLETE.
  - A system that is down gives "did not answer" advice instead of "add cases".
  - After a partial run, drift for cases that did not run is not called unused.
  - Each report states the reason for its verdict and the next step.
- **Sign-off.** It records a fingerprint of the evidence (the answers, REPORT.json, and REPORT.md above its sign-off table) in `SIGNOFF.json` and in the report. `cmtk status` shows who signed, or that a signature no longer counts. A report with no evidence cannot be signed. The docs now say plainly that a terminal prompt is not a lock.
- **Paths.**
  - Evidence and case files cannot reach outside the project through a link.
  - `evidence` cannot be the project folder.
  - The MCP server's path checks now work on Windows.
- **Other fixes.**
  - A request body written as a YAML mapping is sent as JSON.
  - `equals` ignores key order.
  - `cases:` may be a single glob.
  - Case ids that would clash as Windows file names are refused.
  - Proxies are bypassed even when Node is set to use one.
- `cmtk adapter check` also checks `describe`, and adapters have a `timeout_s`.

### Changed

- Node.js 22.5 or later is required, for `path.matchesGlob`.
- **CI:** a run with `--only` now exits with 2 (INCOMPLETE), not 0. A pipeline that runs only some cases on purpose should accept exit code 2, or run every case.
- An adapter's standard error is shown a line at a time, marked `[adapter <name>]`.

### Verified

- 39 tests on Windows and Linux: the 20 from 0.1.0 and 19 regression tests, one or more for each review finding. The reviewer then re-ran each original reproduction against the fixes.

## 0.1.0 (2026-10-16)

First version: the engine, the `cmtk` command and the MCP server.

### Added

- **`cmtk run`** checks one system against each case's `expect:` block: status, headers, JSON values (equals, exists, matches, type) and text in the body. It writes a report grouped by requirement.
- **`cmtk compare`** sends each case to the reference and the candidate. It diffs status, listed headers, body and side effects, and checks OpenAPI (JSON), WSDL and XSD contracts for breaking changes.
  - **Match levels:** `exact`, `semantic` or `contract`, set for the whole system and loosened per path or per case.
  - **Scrub rules** for values that change on every call.
  - **A drift ledger** of differences a named person approved. The verdict is DRIFT ONLY when those are the only differences.
  - **Noise suggestions** in the report: timestamps and GUIDs that differ on every call. They are never applied automatically.
- **`cmtk import-har`** turns browser or proxy recordings into cases, dropping cookies, authorization headers, static files and duplicates.
- **`cmtk signoff`** lets a person sign a report. It refuses to run without a terminal, so agents and scripts cannot sign.
- **Adapters** for any boundary, in any language, speaking JSON lines. `cmtk adapter new` writes a template, and `cmtk adapter check` runs the conformance kit.
- **The MCP server** offers `cmtk_run`, `cmtk_compare`, `cmtk_import_har` and `cmtk_status`. There is no sign-off tool.
- **Docs:** a runbook a person can follow, a settings reference, an adapter guide and the plan.

### Safety

- Requests go only to the configured targets.
- Methods that change data need two switches.
- Credentials come from environment variables and never reach disk.
- Redirects are not followed and proxies are not used.

### Verified

- 20 tests (Node's test runner) on Windows and Linux. Both modes run end to end against local HTTP servers, the CLI runs as a separate process, and the MCP server is exercised through a real client.

### Not yet verified

- On a real project. The eShop sandbox is the first pilot.
