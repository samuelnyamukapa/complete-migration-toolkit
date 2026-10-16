# Changelog

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
