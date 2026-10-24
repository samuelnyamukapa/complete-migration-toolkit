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
| REA (20 Oct 2026) | An optional companion for Discover, never bundled: it changes fast and can install third-party tools. Only its free, built-in engines; only on systems the person owns |
| Test data (23 Oct 2026) | The LLM proposes, deterministic tools decide. The recipe and manifest are committed, never rows an LLM wrote. Boundaries, negatives and combinations always come from the engine. See the thirteen rules in #54 |

## Phases

| Phase | Builds | Pilot | Done when |
|---|---|---|---|
| 0 | `/modernize:parity` in [modernize-for-copilot](https://github.com/samuelnyamukapa/modernize-for-copilot) 1.1 | the billing fixture | a planted difference is caught and nothing else is flagged |
| 1 | **Done (0.1.2): signed reports on eShop, 18 Oct 2026. See [docs/pilots/eshop.md](pilots/eshop.md).** Engine, `cmtk run` and `cmtk compare`, HTTP and SOAP, contracts, drift ledger, reports, CLI, MCP server | eShop sandbox | `cmtk run` and `cmtk compare` give a signed report on eShop |
| 1b | **Built in 0.2.0 and piloted on eShop in 0.2.1; the sprint with a real team is next (#15).** The AI tester: skills that turn stories and runbooks into case files, explore against a charter, and draft defects | eShop, then one real sprint | testers on one team keep using it after the sprint |
| 1c | **Built in 0.3.0.** Discover: `cmtk discover` and `/cmtk:discover` list every boundary of the legacy system with its evidence, and flag the ones no adapter covers. Sources: .NET assemblies through [REA](https://github.com/morluto/rea) (an optional companion, free engines only), settings files, HAR recordings, modernize's `topology.json`, and an agent's findings with evidence | eShop: its assembly and `Web.config` gave 8 boundaries, 3 uncovered (database, files, logs) | every boundary of a pilot system is listed before its comparison, and a person agrees nothing is missing |
| 1d | **In progress (#54): the recipe engine, file bodies and form posts shipped in 0.4.0 to 0.5.0.** Test data: when a case needs data or an input file that doesn't exist, cmtk creates it from the target system's own schemas and rules as a seeded recipe a person reviews, with a manifest that says why each row exists. File bodies and uploads; CSV, Excel and fixed-width files; seeding both systems from one SQL artefact; XML from XSD; the `/cmtk:data` skill. The research is in [research/test-data-generation.md](research/test-data-generation.md) | eShop: the catalog item form and the CSV import | a tester accepts a generated recipe without editing rows, and the same seed gives the same files on Windows and Linux |
| 2 | Adapters: queues, workers, files, database, email, SMS, payment sandboxes; an adapter marketplace | a Windows service rebuilt as a Worker Service; CardDemo batch files | someone outside the core team adds a working adapter in a day |
| 3 | UI: web journeys through e2e or Playwright (structure for a reskin, goals for a new UI), desktop through computer use, MFA with test authenticators | eShop reskinned, then with a new front end | the same journeys pass on both systems, replayed without a model |
| 4 | Shadow traffic, long-running comparison, packaging and 1.0 | one real service rebuilt behind a locked contract | every migration mode proven on a pilot |

Each phase has a [milestone](https://github.com/samuelnyamukapa/complete-migration-toolkit/milestones) and an epic issue (#35 to #39, #47 for 1c and #54 for 1d) listing its work, and [TEST-PLAN.md](TEST-PLAN.md) says what each phase must prove.

## Next steps

1. Try the AI tester with one real team for one sprint, and measure whether they keep using it (#15).
2. Test data, Phase 1d (#54): file bodies and uploads, the recipe engine, data files, then seeding both systems.
3. Discover, the rest of Phase 1c (#47):
   - lock a class library's public surface across builds through REA, which would also unblock #6 (#44);
   - Discover on CardDemo through modernize's map (#45);
   - read controller routes from `[Route]` attributes (#46).
4. Publish to npm as `complete-migration-toolkit`, so `npx cmtk` works (#32).
5. Two items are left from Phase 1:
   - #7: a person follows the runbook by hand on Windows;
   - #6: the contract check, once CatalogCore has a web host.
