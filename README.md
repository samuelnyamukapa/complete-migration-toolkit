# Complete Migration Toolkit

Test any system from its requirements, and prove a migrated system behaves like the old one, with every intended drift approved and signed.

> **Status: 0.1.2, early.** The engine, the `cmtk` command and the MCP server work and are tested on Windows and Linux. The first pilot, on the eShop sandbox, has run:
> - `cmtk run` passed 40 of 41 cases on legacy eShop; the one failure is a legacy defect.
> - `cmtk compare` found parity with CatalogCore across 24 cases, and caught a planted defect.
>
> The reports are waiting for a person's sign-off. See [docs/pilots/eshop.md](docs/pilots/eshop.md) and [docs/PLAN.md](docs/PLAN.md).

## Why

AI has made development fast, but testing has not kept up, so testers become the bottleneck. Migrations make it worse: teams must show the new system does what the old one did, often without changing a single contract that outside consumers rely on.

The toolkit does the grind (writing, running, re-running and gathering evidence) so people can keep the judgement: what to test, what a difference means, and whether to sign.

## Two modes

| | `cmtk run` | `cmtk compare` |
|---|---|---|
| Checks | one system against what each requirement expects | the candidate against the reference (usually the legacy system), answer by answer |
| Use it for | any project, every sprint, every pull request | migrations, upgrades, rewrites, reskins |
| Verdicts | PASS, FAIL, INCOMPLETE, NO EVIDENCE | PARITY, DRIFT ONLY, NO PARITY, INCOMPLETE, NO EVIDENCE |

Both modes write a report per requirement, keep every answer as evidence, and end with a sign-off table that only a person fills in.

**Drift is allowed, but never by accident.** A difference becomes acceptable only when a named person records it in the drift ledger (`cmtk/drift.yaml`). Everything else is reported. When the only differences are approved ones, the verdict is DRIFT ONLY.

## Quick start

The toolkit is not on npm yet. You need Node.js 22.5 or later. From a clone:

```sh
npm install
npm run build
npm link -w packages/cli        # puts `cmtk` on your PATH
```

Then, in the project you want to test:

```sh
cmtk init --legacy http://localhost:5001 --candidate http://localhost:5002
cmtk run          # the candidate against cmtk/cases/*.yaml
cmtk compare      # the same cases on both systems, diffed
cmtk signoff run  # a person signs, at a keyboard
```

A person who has never seen the toolkit can follow [docs/RUNBOOK.md](docs/RUNBOOK.md) step by step.

## A case

```yaml
cases:
  - id: CAT-001
    name: the first catalog page lists twelve items
    requirement: STORY-12/AC-1
    request: GET /api/catalog/items?pageIndex=0
    expect:
      status: 200
      json:
        "$.data[*].name": { type: string }
        "$.count": { equals: 12 }
```

`cmtk run` checks the `expect:` block on one system. `cmtk compare` ignores it, sends the same request to both systems, and lists every difference in status, headers, body, contracts and side effects. The full format is in [docs/MANIFEST.md](docs/MANIFEST.md).

## How strict a comparison is

| Level | What must match | Typical use |
|---|---|---|
| `exact` (default) | status, the listed headers, and the body as sent: number formats, key order, text encoding, XML text as written | anything third parties parse |
| `semantic` | the same data; formatting may differ | internal endpoints, reskinned pages |
| `contract` | the status only; the contracts are still checked | endpoints being retired |

JSON whitespace and string escapes (`\u00e9` for `é`) are not compared at any level, because every JSON parser reads them the same way.

Set one level for the system, then loosen it per path (`overrides`) or per case. The modes in a migration are presets, not fixed choices: an upgrade with a reskinned UI keeps its APIs `exact` while its pages compare at `semantic`.

## What it checks today

- **HTTP:** REST, GraphQL and SOAP. JSON is compared field by field; XML and SOAP by element, so a different namespace prefix is not a difference.
- **Contracts served by both systems:**
  - OpenAPI (JSON): removed operations or parameters, new required parameters, removed responses, removed or retyped properties;
  - WSDL and XSD: removed operations or elements, type changes, a changed target namespace.
- **Anything else, through adapters:** queues, workers, files, email, SMS and payment sandboxes report their side effects as JSON, and the engine compares and checks them like a body. `cmtk adapter new` writes a working adapter, and `cmtk adapter check` runs the conformance kit. See [docs/ADAPTERS.md](docs/ADAPTERS.md).

## For AI agents

The MCP server gives an agent the same verbs a person has: `cmtk_run`, `cmtk_compare`, `cmtk_import_har` and `cmtk_status`. Sign-off is deliberately not a tool.

```json
{ "mcpServers": { "cmtk": { "command": "node", "args": ["<clone>/packages/mcp/dist/server.js"] } } }
```

## Safety

- **Requests go only to the targets in `cmtk.yaml`.** A case holds a path, never a host.
- **Only GET, HEAD and OPTIONS run by default.** Anything that changes data needs two switches: `allow_unsafe_methods: true` in `cmtk.yaml`, and `--allow-unsafe` on the run.
- **Credentials are never stored.** They come from environment variables named in `headers_from_env`, are read at run time, and are never written to the manifest or a report. HAR imports drop cookie, authorization and API-key headers, and replace credential-like query values and body fields (JSON, forms, XML and SOAP) with `REDACTED`. Read imported cases before committing them: a credential under an unusual name can still get through.
- **No hidden behaviour.** Redirects are compared, not followed; proxies are not used, even when Node is set to use one.
- **Nothing outside the project is touched.** Every path, including through links, must stay inside the folder `cmtk.yaml` is in, and a run replaces its evidence only once it has finished.
- **Sign-off is a person's job.** `cmtk signoff` asks at a terminal and records a fingerprint of the evidence, so a signature never carries over to other evidence. The MCP server has no sign-off tool. A terminal prompt is not a lock against a determined script: where a signature must be binding, keep the evidence under version control and review the commit that adds `SIGNOFF.json`.

## Exit codes

`0` PASS, PARITY or DRIFT ONLY · `1` FAIL or NO PARITY · `2` INCOMPLETE or NO EVIDENCE · `3` a usage or settings problem.

## Layout

| Path | What |
|---|---|
| `packages/core` | The engine: settings, cases, adapters, expectations, comparison, contracts, drift, reports |
| `packages/cli` | The `cmtk` command and the adapter template |
| `packages/mcp` | The MCP server |
| `docs/` | Plan, test plan, runbook, settings reference, adapter guide, pilot write-ups |
| `examples/eshop-pilot` | The first pilot's folder, as a worked example: cases, an adapter for a .NET class library, and Windows scripts |

## Contributing

Adapters for third-party dependencies are the most useful contribution: see [docs/ADAPTERS.md](docs/ADAPTERS.md), and ask for one with the adapter request issue template. The work is planned in [milestones and issues](https://github.com/samuelnyamukapa/complete-migration-toolkit/milestones), one epic per phase, and [docs/TEST-PLAN.md](docs/TEST-PLAN.md) says what each phase must prove. Run `npm test` before opening a pull request; CI runs it on Windows and Linux.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
