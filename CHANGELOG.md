# Changelog

## 0.4.0 (2026-10-23)

Test data, part 1. When a case needs a body or an input file that doesn't exist, cmtk creates it from the system's own schema, as a recipe a person reviews. The research behind the design is [docs/research/test-data-generation.md](docs/research/test-data-generation.md); its rule, **the LLM proposes, deterministic tools decide**, is built in: boundaries, negatives and combinations come from the engine, never from a model.

### Added

- **Cases send files.** `body_file` sends a file inside the project as the body, byte for byte. `files` sends a `multipart/form-data` upload, with a fixed boundary so both systems get the same bytes. The evidence records each file's path, size and SHA-256, never its contents, and `REPORT.md` lists them under "Input files".
- **`cmtk data plan`**: a recipe from a JSON Schema or one OpenAPI operation. For every field: its constraints and the part of the schema that justifies them. Rows, each named by the condition it exercises:
  - a valid baseline (equivalence partitioning);
  - three-value boundaries on every ordered field: just below, at, and just above each limit, with `exclusiveMinimum` and `exclusiveMaximum` and `multipleOf` honoured;
  - a negative for every field: missing when required, null when not nullable, the wrong type, outside the enum, a bad format, a broken pattern, not a multiple, a fraction for an integer, too few or too many items;
  - hostile strings on free text: empty, spaces, SQL quotes, markup, a spreadsheet formula, a right-to-left override, accents, emoji, 4,096 characters;
  - pairwise combinations of every enum, boolean, nullable and optional field.
- **Strings from patterns.** A `pattern` is read and a matching string generated, so a field like `^[A-Za-z0-9_-]+\.(png|jpg)$` gets real values. What can't be generated (lookaround, backreferences, Unicode classes) is reported, never guessed.
- **`cmtk data make`**: the rows, regenerated from the seed and the clock, identical on Windows and Linux. Every valid row is checked against the schema, and every invalid row must break it where it says, or the make is refused. Written as `rows.json`, one file per row (for `body_file`), `rows.csv` (UTF-8 with a BOM, CRLF) and `rows.xlsx` (its metadata and zip entries pinned to the recipe's clock, so it never names a person and the bytes never change), with `DATA.md` and a `MANIFEST.json` that records the seed, clock, versions, quota results and every file's SHA-256.
- **Quotas.** At most half the rows may be happy paths; every ordered field gets its boundaries; every field gets a row that breaks it. A recipe a person edited is checked against them by `cmtk data check`.
- **`cmtk data cases`**: one draft case per row, sending the row from its file. An `expect:` is written only where the OpenAPI document gives a status; otherwise a person adds it. The cases wait for `cmtk review`.
- **The `/cmtk:data` skill**, and the `cmtk_data_plan`, `cmtk_data_make`, `cmtk_data_check` and `cmtk_data_cases` tools. The skill's own part is judgement, not rows: findings where the schema and the requirements disagree, questions for the rules the schema can't express, and never a value from production.
- **Dependencies:** `@faker-js/faker` (pinned exactly, because seeds drift between versions; the locales en, en_GB, en_US, de, fr and es are bundled) and `csv-stringify`, both MIT. The workbook writer is cmtk's own, so the bytes of an `.xlsx` are the same on every make; the npm `xlsx` package, with its unpatched advisory, is not used, and nor is `exceljs`, which stamps the zip with the current time.

### Verified

- 74 tests on Windows and Linux.
- On eShop's catalog item, from a schema written from its business rules: 100 rows (37 partitions, 33 boundaries, 20 hostile, 10 pairwise), 11% happy paths, every row checked, the same files from the same seed.

## 0.3.0 (2026-10-20)

Discover: the parity suite's first step, with REA. Before a migration is compared, every boundary of the legacy system is listed, so none is left out by accident.

### Added

- **`cmtk discover`**, the `cmtk_discover` MCP tool and the **`/cmtk:discover`** skill. They list every boundary of the legacy system:
  - what it serves: web pages, APIs, SOAP services, jobs, screens;
  - everything it calls, stores, sends or reads: databases, files, queues, email, SMS, payments, other web services, logs.

  Each boundary says where it was found, and which adapter covers it. The rest are flagged as **uncovered**. The inventory is written to `cmtk/discovery/BOUNDARIES.md`, and each run adds to it unless you pass `--fresh`.
- **Sources:**
  - .NET assemblies, read by [REA (Reverse Engineer Anything)](https://github.com/morluto/rea) without running them;
  - REA's saved output;
  - `Web.config`, `App.config` and `appsettings.json`;
  - HAR recordings;
  - modernize's `topology.json`;
  - an agent's findings, each with its evidence.

  REA is optional: `npm install --global rea-agents`, or set `CMTK_REA`.
- **`covers:`** on an adapter in `cmtk.yaml`: the kinds of boundary it checks.
- **`cmtk check`** reports the last discovery, and warns about each uncovered boundary.

### Safety

- Connection strings give only their server and database. URLs lose their user name, password and query.
- The skill uses REA only on systems the person owns, only its free engines, and never runs the legacy system.
- Only a person decides that a boundary is out of scope.

### Verified

- 64 tests on Windows and Linux.
- On eShop: REA read `eShopLegacyMVC.dll` in about 2 seconds, with no other tools. With its `Web.config`, discovery listed 8 boundaries:
  - 5 controllers;
  - the catalog database, matched to its connection string;
  - picture and customisation files;
  - log4net.

  The last three are flagged as uncovered.
- REA's member comparison can't lock a library across a namespace move, such as `eShopLegacyMVC.*` to `CatalogCore.*`; that is #44.

## 0.2.1 (2026-10-20)

Fixes from part 2 of the eShop pilot: the AI tester run from the GitHub Copilot desktop app on Windows. The write-up is part 2 of [docs/pilots/eshop.md](docs/pilots/eshop.md).

### Added

- **A run stops early when the system stops answering.** After 3 requests in a row get no answer, the remaining cases are reported as not run, with the reason. Before, each case waited out its timeout: on a hung system a run of 42 cases would have taken over an hour, and Copilot gave up on the tool call while the run went on.
- **One run at a time** per evidence folder, so a second run can't delete the first one's half-written evidence.
- **Defect drafts are titled with the case's name** when it has one, and have a "Why it matters" section when the case's note says why.

### Fixed

- **Accepting a draft kept no record of where it came from.** Its note, which names the rule it was drawn from and the question it waits on, is now kept as `note`.
- **`/cmtk:explore`** sends its requests one at a time. The tool already refused parallel requests.
- **`/cmtk:test`** points a skipped case to the question it waits on. It no longer offers to add an expectation itself.
- **The plugin README** gives Claude Code's full update commands. It also says the version must go up for every plugin change: Claude Code treats a change under the same version as already installed.

### Verified

- 61 tests on Windows and Linux.
- **On eShop, from the GitHub Copilot desktop app on Windows:**
  - the owner accepted all 39 drafted cases unchanged, and they ran with 30 passing and none failing;
  - an exploration session found three problems in 12 requests;
  - after the owner accepted those, the run failed on two of them, two defects were drafted, and the owner had one filed with no rewriting;
  - triage of the canary comparison made one correct defect proposal, and noticed the report was out of date.

  Nothing was approved, signed or filed by an agent.
- **A clean install on Linux, from a fresh home folder:**
  - Claude Code 2.1.304 installed the plugin in 3 seconds, and Copilot CLI 1.0.100 in 17;
  - neither needed a sign-in to install;
  - both loaded the 5 skills and the tool server;
  - `claude plugin validate` passes for the plugin and the marketplace.

## 0.2.0 (2026-10-18)

The AI tester: skills that do the grind of testing, while people keep the judgement. Works on any project, not only migrations.

### Added

- **The cmtk plugin** for GitHub Copilot (CLI and app) and Claude Code, installed from this repository's marketplaces. It has five skills:
  - `/cmtk:test`: start here;
  - `/cmtk:plan`: stories, runbooks or OpenAPI become a test plan and draft cases;
  - `/cmtk:triage`: noise, drift or defect for each group of differences;
  - `/cmtk:explore`: charter-based exploration, read-only and within a budget;
  - `/cmtk:defects`: defect drafts with their evidence.

  The MCP server and the `cmtk` command are bundled inside, so the plugin needs only Node.js.
- **Draft cases** (`draft: true`): reported as SKIPPED until a person accepts them.
- **Proposals** (`cmtk/proposals.yaml`): agents propose scrubs, drift, defects and new expectations; nothing is applied until a person decides.
- **`cmtk review`**: a person accepts or rejects each draft and proposal at a keyboard. Accepted items are applied with that person's name, and comments and line endings in the files survive. Rejected drafts are kept, with the reason, in `cmtk/rejected.yaml`.
- **Exploration sessions**: a charter, a target, and a budget of requests and minutes. Sessions only read, log every answer as evidence, turn findings into draft cases, and end with `SESSION.md`.
- **`cmtk defects run|compare`**: one draft per cause, with steps, expected, actual and evidence, and credentials removed. Drafts don't affect a signature.
- **`cmtk check`** (sends nothing) and **`cmtk probe`** (one read-only request).
- **`cmtk init` with only `--candidate`**: writes settings for testing one system, with nothing about migrations.
- **MCP tools**: `cmtk_init`, `cmtk_check`, `cmtk_propose`, `cmtk_proposals`, the `cmtk_explore_*` tools, `cmtk_defects` and `cmtk_commands_for_person`. There is still no tool that decides or signs.
- **[docs/TESTER-RUNBOOK.md](docs/TESTER-RUNBOOK.md)**: from stories to a signed report, in four ways of working (requirements, runbook, explore, regression).
- **[examples/bookshop](examples/bookshop)**: a small API with planted bugs, a version 2 with planted noise, drift and a defect, and a CI workflow example.
- **`--accepted-only`** for `cmtk run` and `cmtk compare` (and `accepted_only` on the MCP tools): drafts are left out, and the report says how many. CI uses it.
- **`body_excludes`** in `expect:`: text that must never appear, such as a stack trace.
- **Settings in every report:** the settings file and its SHA-256, the match level, the scrub rules and the drift ledger in force. `cmtk status` shows which settings file a report came from.
- **`explore_requests_per_day`** (default 1000): a limit on exploration requests per day, across sessions.

### Fixed before release

An independent review checked every route by which an agent could decide, sign, or reach further than it should. All its findings are fixed, each with a regression test (`packages/core/test/tester-review.test.mjs`, and the MCP tests):

- `cmtk init` and `cmtk_init` refuse an address that could write other settings into `cmtk.yaml`, and quote the addresses they write.
- Sign-off refuses a report produced from another settings file, and records the settings file and its fingerprint.
- `cmtk review` refuses an item that changed after it was shown, and refuses text with control characters (which could hide what a person reads). A drift proposal for every case and every path is refused; one for every case says so in capitals.
- Exploration sends one request at a time per session, refuses method-override headers, and counts open sessions' whole budget against the daily limit.
- Defect drafts remove credential-like query values, credentials in request bodies, and a user name or password in a target's address.
- HAR files imported by an agent through MCP become draft cases.
- The commands handed to a person are quoted for their shell, so an unusual folder name can't run anything else.
- `cmtk review` keeps going when one item fails, says which, and stops cleanly when the terminal closes.

### Verified

- 58 tests on Windows and Linux.
- The skills were tried by agents on the bookshop example and on the eShop pilot's rules, and judged against what was planted:
  - `/cmtk:explore` found the three planted bugs in version 1 (a negative page, a non-numeric id, a page size of 0), within its budget and without changing data;
  - `/cmtk:triage` sorted every planted difference in version 2 correctly: two kinds of noise, the currency drift, the title-sort defect, and the health version as a question for a person;
  - `/cmtk:plan` on the eShop rules: 43 of 44 drafted cases were judged acceptable or better. It missed three areas of scope, so the skill now requires a case for everything the scope names, plus the entry point and an unknown address. A second try covered every area, with a question wherever the rules say nothing.

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
