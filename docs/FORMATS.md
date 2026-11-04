# Formats you can rely on

This page lists what will not break without a new major version. It is written for 1.0, and 1.0 is not tagged yet: until then, a minor version can still change these, and the [changelog](../CHANGELOG.md) says when one does. An outside review of the safety rules and of these docs is still open ([#33](https://github.com/samuelnyamukapa/complete-migration-toolkit/issues/33)).

## The promise

From 1.0.0, version numbers are major.minor.patch.

- **A major version** may change anything on this page, and the changelog says how to move.
- **A minor version** may add: a new optional setting, a new field in a report, a new command, a new tool. So read a report by the fields you know, and ignore the rest.
- **A patch version** adds nothing here.
- **The safety rules never loosen,** in any version: the two switches for unsafe methods (a `safe: true` counts only with a person's confirmation in `cmtk review`), secrets only from environment variables, sandboxes only for money and messages, and only a person signs. See [TEST-PLAN.md](TEST-PLAN.md).

A difference that is reported today may be worded differently tomorrow. The words in `reason`, `next` and `why`, and everything in `REPORT.md`, are for people, and they can change in any version. A program reads the fields, the verdicts and the exit codes.

Not frozen: the functions of `@cmtk/core`, `cmtk/proposals.yaml`, `cmtk/discovery/`, session files and recipes, which the toolkit writes for itself. A person can read them, but no program should depend on them yet.

## JSON Schemas

Each file has a schema in [schemas/](../schemas/), so an editor can check it as you type.

| File | Schema | Meaning of each field |
|---|---|---|
| `cmtk.yaml` | [cmtk.schema.json](../schemas/cmtk.schema.json) | [MANIFEST.md](MANIFEST.md#cmtkyaml) |
| Case files | [cases.schema.json](../schemas/cases.schema.json) | [MANIFEST.md](MANIFEST.md#case-files) |
| `cmtk/drift.yaml` | [drift.schema.json](../schemas/drift.schema.json) | [MANIFEST.md](MANIFEST.md#drift-ledger-cmtkdriftyaml) |
| `cmtk/known-issues.yaml` | [known-issues.schema.json](../schemas/known-issues.schema.json) | [MANIFEST.md](MANIFEST.md#known-issues-ledger-cmtkknown-issuesyaml) |
| `REPORT.json` from `cmtk run` and `cmtk compare` | [report.schema.json](../schemas/report.schema.json) | [Below](#reportjson) |
| `REPORT.json` from `cmtk shadow` | [shadow-report.schema.json](../schemas/shadow-report.schema.json) | [SHADOW.md](SHADOW.md) |
| Each line of `capture.jsonl` | [capture.schema.json](../schemas/capture.schema.json) | [SHADOW.md](SHADOW.md) |
| `TREND.json` | [trend.schema.json](../schemas/trend.schema.json) | [TRENDS.md](TRENDS.md) |
| Each line to an adapter | [adapter-request.schema.json](../schemas/adapter-request.schema.json) | [ADAPTERS.md](ADAPTERS.md#the-protocol) |
| Each line from an adapter | [adapter-reply.schema.json](../schemas/adapter-reply.schema.json) | [ADAPTERS.md](ADAPTERS.md#the-protocol) |

To check a file in VS Code with the YAML extension, put this at the top of it:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/samuelnyamukapa/complete-migration-toolkit/main/schemas/cmtk.schema.json
```

The schema is stricter than the toolkit in one way: it flags a key it does not know, so a mistyped key shows in your editor. The toolkit itself ignores an unknown key in `cmtk.yaml` or a case, and an adapter's own settings under a target are always allowed. What the toolkit refuses when it reads a file, such as a drift entry with no `approved_by`, the schema flags too.

## REPORT.json

Always present: `tool`, `mode`, `system`, `date`, `verdict`, `targets`, `counts`, `cases`, `contracts`, `requirements`, `unused_drift`, `suggested_scrubs`, `partial`, `reason`, `next`.

| Field | Meaning |
|---|---|
| `verdict` | One of the verdicts [below](#exit-codes) |
| `targets` | Each target's name and address, with any password removed |
| `counts` | How many cases got each result |
| `cases[].result` | `PASS`, `FAIL`, `MATCH`, `DRIFT`, `DIFFERENT`, `NOT COMPARABLE`, `SKIPPED` or `ERROR` |
| `cases[].differences[].where` | Where they differ, as listed in [MANIFEST.md](MANIFEST.md#where-values-in-a-report-come-from). `drift` names the entry that approves it |
| `cases[].failures[]` | `check`, `expected`, `actual`, and the `known_issue` that accepts it |
| `cases[].truncated` | An answer was over 5 MB, so only the first 5 MB were read |
| `unused_drift` | Entries that matched nothing |
| `partial` | Only some cases ran, because of `--only` |

Present only when they apply: `scope`, `settings`, `known_issues`, `stale_known_issues`, `excluded_drafts`, `excluded_compare_only`, `scrub_fired`.

`SIGNOFF.json` is written by `cmtk signoff`, beside the report. Its `evidence_sha256` ties a signature to the evidence. A program can read it, and only a person writes it.

## Exit codes

| Code | Verdicts | Means |
|---|---|---|
| 0 | PASS, PARITY, DRIFT ONLY | The result has no limit a person must read. `cmtk trend`, `cmtk check`, `cmtk init` and other commands that finish normally also exit 0 |
| 1 | FAIL, NO PARITY, UNEXPLAINED DIFFERENCES | Something new failed or differs. A failed `cmtk adapter check` also exits 1 |
| 2 | INCOMPLETE, NO EVIDENCE | Something could not be checked. `cmtk trend` with no dated runs also exits 2 |
| 3 | | A usage or settings problem. Nothing was run |
| 4 | PASS WITH KNOWN ISSUES, PARTIAL COMPARISON, NO UNEXPLAINED DIFFERENCES | Nothing new failed, but the result has a limit a person must read |

A pipeline that gates a release on parity checks for 0. Code 4 is never 0, on purpose.

## Adapter protocol

One JSON request per line on standard input, and one JSON reply per line on standard output. Diagnostics go to standard error. [ADAPTERS.md](ADAPTERS.md#the-protocol) has the full text.

| Request | Reply |
|---|---|
| `{"op":"describe"}` | `{"name":…,"kinds":[…],"settings":[…]}` |
| `{"op":"run","case":…,"target":…,"headers":…}` | An observation: any of `status`, `headers`, `body`, `body_encoding`, `sha256`, `truncated`, `effects`, or `{"error":…}` |
| `{"op":"reset","target":…}` | `{"ok":true}`, or anything else to fail that case |

## MCP tools

These tools keep their names and their required inputs. A minor version may add a tool or an optional input.

No tool can approve, sign, accept or decide anything. A new tool that could would break the safety rules, and no version may add one. There is no tool for `cmtk shadow` or `cmtk trend`: recordings of real traffic stay away from models.

| Tool | What it does |
|---|---|
| `cmtk_check` | Checks the settings and case files, and sends nothing |
| `cmtk_commands_for_person` | The exact commands a person types for the steps only a person may do |
| `cmtk_compare` | Sends each case to both systems, and diffs the answers |
| `cmtk_data_cases` | One draft case per row of a recipe |
| `cmtk_data_check` | Checks a recipe without writing files |
| `cmtk_data_diff` | Compares two data files by meaning, not bytes |
| `cmtk_data_finding` | Records where the schema, the rules and the traffic disagree |
| `cmtk_data_make` | Regenerates a recipe's rows, and checks them |
| `cmtk_data_plan` | Compiles a test-data recipe from a schema |
| `cmtk_data_propose` | Proposes a rule a schema can't say, for a person to review |
| `cmtk_data_seed` | Writes one SQL script and a manifest to seed both systems. It never connects to them |
| `cmtk_data_traffic` | Compares a HAR recording with a recipe's schema: only paths, counts and reasons come out |
| `cmtk_defects` | Drafts defects from the latest report |
| `cmtk_discover` | Lists every boundary of the legacy system |
| `cmtk_explore_end` | Ends a session, and writes its report |
| `cmtk_explore_finding` | Records a finding as a draft case |
| `cmtk_explore_request` | Sends one read-only request in a session |
| `cmtk_explore_start` | Starts an exploratory session |
| `cmtk_import_har` | Turns a recording into draft cases |
| `cmtk_init` | Starts a project |
| `cmtk_proposals` | Lists proposals |
| `cmtk_propose` | Proposes a change for a person to decide |
| `cmtk_run` | Checks one system against each case's expectations |
| `cmtk_status` | The latest verdicts, and who signed |

## Performance limits

These are what a test on one machine proves. They are not yet agreed with a client, and they are not a promise about your machine or your systems. The time your systems take to answer comes on top.

| What | Tested limit | Tested time |
|---|---|---|
| Cases in one project, read and checked | 5,000 | Within 30 seconds each |
| Cases in one project, compared or run | 2,000 | Compared within 2 minutes and run within 1, against a stand-in on the same machine |
| One answer | 5 MB, after decompression. Reading stops there | |
| One 5 MB JSON answer | Equal, or with a difference in each of 80,000 items | Within 30 seconds |
| One 5 MB JSON answer, at its worst | Over 200,000 differences | Within 60 seconds |
| One 5 MB text answer | | Within 30 seconds |
| One 5 MB XML answer | 100,000 elements | Within 60 seconds |
| One report | 100,000 differences. `REPORT.md` shows the first 500, and `REPORT.json` holds them all | Within 20 seconds to make, and 20 to render |
| JSON nesting | 1,000 levels. Deeper JSON is compared as text | |
| One shadow log | 200,000 lines | Read within 60 seconds |
| One trend | 365 runs of 2,000 cases | Within 30 seconds |

**Over the 5 MB limit, the answer is cut.** What lies past the limit is not looked at, so the verdict is never PASS or PARITY: it is INCOMPLETE for `cmtk run` and `cmtk shadow`, and PARTIAL COMPARISON at best for `cmtk compare`. The report names the cases.

**Very dense XML costs far more than its size suggests.** In one measurement, 5 MB holding 660,000 elements took 17 seconds and 2.4 GB of memory, because the whole document is held in memory to compare it. That is outside the tested limit.
