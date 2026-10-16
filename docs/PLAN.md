# Plan

The toolkit is two things that share one engine and one set of adapters:

- **The tester** works on any project. It takes requirements, a runbook or a spec, and plans, writes, runs and reports tests.
- **Migration comparison** works on top of the tester. It runs the same cases on the legacy and the new system and reports every difference that has not been approved as drift.

## Decisions taken (16 Oct 2026)

| Decision | Choice |
|---|---|
| Engine language | TypeScript. Adapters can be in any language, so .NET-specific ones can be C# |
| Name | Complete Migration Toolkit; the command is `cmtk` |
| Licence | Apache-2.0, public from the start |
| First pilot | The eShop sandbox |
| Contracts | Locked by default; changes are approved drift |

## Phases

| Phase | Builds | Pilot | Done when |
|---|---|---|---|
| 0 | `/modernize:parity` in [modernize-for-copilot](https://github.com/samuelnyamukapa/modernize-for-copilot) 1.1 | the billing fixture | a planted difference is caught and nothing else is flagged |
| 1 | **This repo, 0.1.x:** engine, `cmtk run` and `cmtk compare`, HTTP and SOAP, contracts, drift ledger, reports, CLI, MCP server | eShop sandbox | `cmtk run` and `cmtk compare` give a signed report on eShop |
| 1b | The AI tester: skills that turn stories and runbooks into case files, explore against a charter, and draft defects | eShop, then one real sprint | testers on one team keep using it after the sprint |
| 2 | Adapters: queues, workers, files, database, email, SMS, payment sandboxes; an adapter marketplace | a Windows service rebuilt as a Worker Service; CardDemo batch files | someone outside the core team adds a working adapter in a day |
| 3 | UI: web journeys through e2e or Playwright (structure for a reskin, goals for a new UI), desktop through computer use, MFA with test authenticators | eShop reskinned, then with a new front end | the same journeys pass on both systems, replayed without a model |
| 4 | Shadow traffic, long-running comparison, packaging and 1.0 | one real service rebuilt behind a locked contract | every migration mode proven on a pilot |

Each phase has a [milestone](https://github.com/samuelnyamukapa/complete-migration-toolkit/milestones) and an epic issue (#35 to #39) listing its work, and [TEST-PLAN.md](TEST-PLAN.md) says what each phase must prove.

## Next steps

1. Run the eShop pilot (#35):
    - `cmtk init` in the eShop sandbox, with cases for the catalog pages and API;
    - `cmtk run` against the legacy system;
    - `cmtk compare` against the transformed CatalogCore.
2. Write the AI tester skills (#36): `/cmtk:plan` (stories to case files), `/cmtk:triage` (differences to scrub, drift or defect, always with a person) and `/cmtk:explore`.
3. Publish to npm as `complete-migration-toolkit`, so `npx cmtk` works (#32).
