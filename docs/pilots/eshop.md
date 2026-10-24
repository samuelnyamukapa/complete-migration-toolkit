# Pilot 1: the eShop sandbox

Date: 16 October 2026. Toolkit: cmtk 0.1.1, plus the fixes this pilot led to (0.1.2).
The folder used is kept as a worked example in [examples/eshop-pilot](../../examples/eshop-pilot).

## Summary

| | Result |
|---|---|
| `cmtk run`: legacy eShop against the catalog stories | **FAIL**: 40 of 41 cases pass. The one failure is a legacy defect, explained below |
| `cmtk compare`: legacy catalog service against CatalogCore | **PARITY**: 24 of 24 cases identical at `exact`, with no scrubs and no drift |
| Planted defect in CatalogCore (the canary) | **NO PARITY**: caught in 7 cases, every one at `$.TotalPages` |
| The eShop sandbox | Unchanged: all 1,199 files match the checksums taken before the pilot |
| Windows | Every check passed: spaces and long paths, line endings, `$env:` credentials, sign-off and the MCP server |
| Sign-off | **Both reports signed and accepted on 18 October 2026**: the run by the architect, the comparison by the manager |

It took about 25 minutes from the first script to the final reports, on the machine that hosts the sandbox.

## What was tested

**The systems.**
- **Legacy:** eShop, ASP.NET MVC 5 on .NET Framework 4.7.2. It ran as a scratch copy built by VS MSBuild and hosted by IIS Express on port 53190, with mock data, so no database was needed.
- **CatalogCore:** the catalog service rebuilt for .NET 8 by the modernize plugin. It is a class library with no web host yet.

**`cmtk run`: 41 cases on legacy over HTTP, each naming its acceptance criterion.**
- **24 cases from the stories:**
  - the catalog pages: paging, details, the create, edit and delete forms;
  - pictures;
  - the brands, files and hello APIs.

  They include unhappy paths: unknown ids, missing ids, a page past the end, and page sizes of 0 and -10.
- **17 cases from a HAR recording** of the site used in Microsoft Edge:
  - 197 requests were recorded;
  - 180 were left out as static files or duplicates of existing cases;
  - cookies were dropped;
  - each kept case was then given a requirement and an expectation.

**`cmtk compare`: 24 cases on both systems, through the catalog service itself.**
- **Why the service:** CatalogCore has no web host, so the comparison could not use HTTP.
- **How it works:** a small C# probe is built twice from one source file:
  - once against the real legacy assembly (net472);
  - once against CatalogCore (net8.0).

  The `catalog` adapter runs the right build for each target.
- **What the cases cover:**
  - paging, including the edge cases;
  - finding items;
  - brands and types;
  - item validation, including the two quirks the modernize plugin found: DELTA-023 (culture-sensitive price check) and DELTA-029 (range check rounds first).

## What the reports say

### The legacy run: one failure, a legacy defect

`API-2-01` expects `GET /api` to answer `{"Message":"Hello World!"}`, as its controller intends. Legacy answers 404. The controller class is named `CatalogController2`, and ASP.NET MVC only registers classes whose names end in `Controller`, so the route never exists.

This is recorded as known legacy issue **LEG-1** (cmtk has no ledger for it yet: #40). The case was not changed to hide it. By the migration rule (match legacy first, fix later as approved drift), the new host must also answer 404 until the API's owner decides otherwise.

The run also confirmed these legacy quirks, so a migration has to keep them:
- **RULE-006:** the pager says "Showing 10 of 12" on the last page, which holds two items.
- **RULE-005:** a page size of 0 gives a server error (500).
- **RULE-004:** a negative page size is not rejected; the page shows "Page 1 - -1".
- **Content negotiation:** the brands API answers in XML when a browser asks (its `Accept` header lists XML) and in JSON otherwise. Only the HAR cases showed this, because they replay the browser's headers.

### The comparison: parity at the service interface

All 24 cases match, byte for byte, including:
- the `DivideByZeroException` for a page size of 0, with the same message on both runtimes;
- the integer overflow when page size times page index passes 2,147,483,647 (RULE-004): both return every item;
- every validation message, and the comma-decimal culture rejecting `19.50`.

**Scrubs and drift: none.** Nothing differed, so there was nothing to scrub or approve.

**Proving the comparison can fail.** Issue #5 asks for a drift entry to be removed to show its difference comes back. With no drift entries, a canary was used instead:
1. The scratch CatalogCore was changed to round the page count down (`Math.Floor`).
2. `cmtk compare` gave NO PARITY with 7 differences, each at `$.TotalPages`.
3. The change was undone, and the comparison returned to PARITY.

### Contracts (issue #6)

Neither system serves a contract document:
- the legacy Web API has no OpenAPI (Swagger) document and no WSDL;
- CatalogCore has no host.

Nothing was added to either system. The check belongs with the phase that gives CatalogCore its host.

## What this pilot does not prove

- **Web pages and the HTTP API on the new system.** CatalogCore has no host yet, so only the service interface was compared.
- **The SQL path.** Legacy ran on mock data, so Entity Framework 6 against a future EF Core is untested.
- **Changes to data.** The pilot was read-only. Create, update and delete on the mock are covered by the modernize plugin's characterization suite (63 cases on each build).
- **That the expectations are complete.** An agent drafted every expectation from the business rules and reviewed the HAR cases. The people who signed accepted both reports, but a requirement with no case can't show up as a failure.

## What we learnt

| What happened | What we did |
|---|---|
| CatalogCore has no address, but every target needed a `base_url` | **Fixed:** a target can carry adapter settings instead of a `base_url` |
| Node 22.14 printed an "ExperimentalWarning" on every command | **Fixed:** cmtk hides that one warning |
| Imported cases recorded the HAR file's full path, which can name a person's folders | **Fixed:** only the file name is kept |
| A FAIL that is a known legacy defect keeps the run at FAIL for ever | **Issue #40:** a ledger of known issues, approved by a named person like drift |
| Imported HAR cases cannot run until someone writes their `expect:` | **Issue #41:** draft each expectation from the recorded answer, for a person to confirm |
| Comparing one surface needed its own manifest (`compare-catalogcore.yaml`) | **Issue #42:** let a case or a target say which surfaces it takes part in |
| The C# probe built for two runtimes is a reusable pattern | Added to #20, the C# adapter template |
| The `npm` command on the pilot machine pointed at a missing file | **Runbook:** use `C:\Program Files\nodejs\npm.cmd` |
| `git pull` failed once with "unable to write file … Permission denied" | **Runbook:** retry with `git -c core.fscache=false pull` |
| An imported case replays the browser's `Accept` header, so a Web API may answer in XML instead of JSON | **Runbook:** a note under importing HAR |

## Windows checks (issue #7)

All ran from scripts on Windows 10 with PowerShell 5.1 and Node.js 22.14. Long paths were not enabled in Windows.

| Check | Result |
|---|---|
| A case file saved with Windows line endings (CRLF) | Loaded and passed |
| `cmtk init` in a folder whose name has a space | Pass |
| `--manifest .\cmtk.yaml` given as a relative path | Pass |
| An evidence path of 292 characters, past the old 260 limit | Written and read back |
| A credential set with `$env:` reaching `headers_from_env` | Sent, and found in no file on disk |
| `cmtk signoff` with piped input | Refused, exit code 3 |
| The MCP server driven by an MCP client on Windows | Four tools, no sign-off tool; `D:\elsewhere`, `\\server\share` and `..\` paths all refused |

**Still to do for #7:** a person following the runbook by hand, and signing in Windows Terminal and in the VS Code terminal.

## Sign-off (issue #8)

On 18 October 2026 both reports were signed in a terminal on the pilot machine, with `cmtk signoff`:

| Report | Verdict | Signed by (role) | Decision |
|---|---|---|---|
| `cmtk run`, legacy against the stories | FAIL (LEG-1 only) | Architect | accept |
| `cmtk compare`, legacy against CatalogCore | PARITY | Manager | accept |

Each signature is stored in `SIGNOFF.json` with a fingerprint of its evidence. `cmtk status` names each signer.

#8 also asks whether a signature survives a change to its evidence. This was checked on copies of the signed folders:

| Change to the copy | What `cmtk status` said |
|---|---|
| None | still signed |
| One answer file edited | "the signature … is for different evidence, so it no longer counts" |
| The verdict line in REPORT.md edited | "the signature … is for different evidence, so it no longer counts" |

This means Phase 1's goal is met: `cmtk run` and `cmtk compare` gave signed reports on eShop.

## Part 2: the AI tester (19 and 20 October 2026)

The same machine and legacy eShop, with cmtk 0.2.0 (fixes released in 0.2.1) and its plugin installed in the GitHub Copilot desktop app. The files are in [examples/eshop-pilot/tester](../../examples/eshop-pilot/tester), and the reports are the `tester-*` files in [reports](../../examples/eshop-pilot/reports). The signed reports from part 1 were not touched: `cmtk status` still showed both signatures afterwards.

| Step | Result |
|---|---|
| `/cmtk:plan` on the 33 rules extracted from the eShop code | 39 draft cases covering every area of the scope, and 12 questions where the rules say nothing |
| The owner's review with `cmtk review` | All 39 accepted unchanged, none rejected |
| `cmtk_run` from Copilot | **INCOMPLETE**: 30 pass and 0 fail. 9 are skipped until the questions are answered |
| `/cmtk:explore` with a budget of 30 requests | 12 requests, all GET, and 3 findings. Error pages show the server's folder path, "not found" pictures hide a stack trace, and odd paging values fall back to the first page (`pageIndex=2147483647` shows "Page -2147483648") |
| The owner's review of the findings | All 3 accepted |
| `cmtk_run` again | **FAIL**: 30 pass, 2 fail (the two leaking error pages), 10 skipped |
| `/cmtk:defects run` | 2 defect drafts with steps, expected, actual and evidence. Nothing filed |
| Filing | The owner had D-01 filed in a local defect log (`tester\defects.md`) exactly as drafted, with only a date and status added. D-02 is not filed |
| `/cmtk:triage --manifest compare-canary.yaml` on part 1's canary comparison | One defect proposal for all 7 differences (`$.TotalPages` one lower than legacy, against RULE-005). It also noted that today's CatalogCore source rounds up, so the 16 October report may be stale and should be run again before anything is fixed. That is right: the planted defect had been removed. The settings file says the canary has a planted defect, and the agent said it read that |

### What we learnt

| What happened | What we did |
|---|---|
| Accepting a draft deleted its note, which said which rule the case came from and which question it waits on | **Fixed:** the note is kept as `note` |
| The explorer sent ten requests at once; the tool refused nine, as designed | **Fixed:** the explore skill says to send them one at a time |
| The test skill offered to "add expectations" to accepted cases that were waiting for the owner's answers | **Fixed:** it points to the open question instead |
| Legacy stopped answering after its first request, every time. IIS Express writes its logs to Documents, which OneDrive syncs on this machine | **Pilot:** `06-start-legacy.cmd` sets `IIS_USER_HOME` to a folder in `scratch\` and checks a second request |
| Each case then waited out its 120-second timeout, so a run of 42 cases would have taken over an hour, and Copilot gave up on the tool call while the run went on | **Fixed:** after 3 requests in a row get no answer, the run stops and says why |
| A second run could have started while the abandoned one was still writing the same evidence folder | **Fixed:** one run at a time per evidence folder |
| Defect drafts were titled with the failed check, such as `body: expected never contains "Physical Path"` | **Fixed:** a draft is titled with its case's name when the case has one |
| `02-start.cmd` reruns part 1's run and compare, which would replace the signed reports; Copilot suggested it when legacy hung | **Pilot:** the README says to use `06-start-legacy.cmd` for the AI tester |
| `copilot plugin update` failed: a running Copilot session held the plugin folder | Known: the plugin README says to close every session first |
| The first start script was removed from the pilot folder while the pilot ran, and its name could not be reused; the cause is unknown | **Pilot:** the script is now `steps\start-legacy.ps1` |

## Part 3: Discover, with REA (20 October 2026)

Read-only copies of legacy eShop's own assembly (`eShopLegacyMVC.dll`) and its `Web.config` were taken from the pilot folder. `cmtk discover` was run on them with REA 6.7.0 (`rea-agents`), using only its built-in .NET analysis. The result is [reports/discover.BOUNDARIES.md](../../examples/eshop-pilot/reports/discover.BOUNDARIES.md).

| Found | From |
|---|---|
| 5 controllers: `CatalogController`, `PicController`, `Api.CatalogController2`, and the Web API's `BrandsController` and `FilesController` | REA: the types that call `System.Web.Mvc.Controller` or `System.Web.Http.ApiController` |
| The catalog database: LocalDB, `Microsoft.eShopOnContainers.Services.CatalogDb` | The connection string `CatalogDBContext`, matched to REA's finding that the type `CatalogDBContext` uses Entity Framework |
| Files: pictures read by `PicController`, and the customisation zip unpacked by `CatalogDBInitializer` | REA: calls to `System.IO.File` and `ZipFile` |
| Logs: log4net | REA |

The controllers are covered by the built-in HTTP adapter. The database, files and logs are flagged as **uncovered**: no adapter checks them yet. That matches what the business rules say eShop does (RULE-008, RULE-019, RULE-023, RULE-025).

### What we learnt

| What happened | What we did |
|---|---|
| REA read the assembly in about 2 seconds, with no other tools installed | Assemblies are a Discover source; REA is an optional companion |
| Routes are guessed from controller names, so `PicController` shows `/Pic` where the real route is `/items/{id}/pic`. REA lists `[Route]` attributes but doesn't decode their arguments | **#46** |
| REA's member comparison found almost nothing in common between the legacy catalog service and CatalogCore, because the namespace moved. It is built for two builds of one assembly | **#44**: compare a library's public surface after a namespace map |

## Part 4: test data (23 October 2026)

The first try of `cmtk data` (0.4.0, with the fixes below released in 0.4.1), on the same legacy eShop rules, without running anything against the system. Legacy eShop has no OpenAPI document and no JSON Schema, so the AI tester wrote two schemas from `BUSINESS_RULES.md`, each constraint quoting its rule, as the data skill says to do when there is none. They are in [examples/eshop-pilot/tester/cmtk/data/schemas](../../examples/eshop-pilot/tester/cmtk/data/schemas); the recipes compiled from them are beside them, and their summaries are the `data-*.DATA.md` files in [reports](../../examples/eshop-pilot/reports). The rows themselves are not kept in git: `cmtk data make <id>` regenerates them, byte for byte, from the seed in the recipe.

| Schema | Rows | Technique | Happy paths |
|---|---|---|---|
| `catalog-item`: an item as the Create and Edit forms take it (RULE-011 to RULE-014, RULE-022, RULE-032, RULE-033) | 100, of which 49 the schema calls valid | 38 EP, 33 BVA-3, 20 hostile, 9 pairwise | 10 (10%) |
| `customisation-row`: one row of `Setup/CatalogItems.csv`, the customisation import (RULE-015, RULE-030) | 76, of which 32 valid | 39 EP, 9 BVA-3, 20 hostile, 8 pairwise | 9 (12%) |

What the rows look like against the rules:

- **RULE-013** says a price of 19.999 is rejected, 19.50 and 0 are accepted and 1,000,000.01 fails. The recipe has exactly those conditions, named: `Price_minimum_at_3bva` (0), `Price_maximum_at_3bva` (1,000,000), `Price_maximum_above_3bva` (1,000,000.01, invalid), `Price_not_a_multiple` (invalid). Nobody typed them: they follow from `minimum`, `maximum` and `multipleOf`.
- **RULE-014**'s three stock fields each get their six boundary rows, and `AvailableStock_fraction` for a decimal where an integer is expected.
- **RULE-015** says the brand and type lookups are case-sensitive and a price of `12,5` throws. The recipe has `catalogtypename_enum_other_case` (`mug` for `Mug`), `price_breaks_pattern` and, in `rows/<name>.csv`, one CSV per condition with the import's own column names.
- **Hostile rows** on every free-text field: a quote, markup, `=1+1`, a right-to-left override, emoji, 4,096 characters. The schema says these are valid where they fit the length, and marks the oracle `implicit`: what the system should do with them is a question, not a check.
- **`cmtk data cases`** wrote 100 draft cases for `catalog-item` in a few seconds, one per row, each sending its row file to `POST /Catalog/Create`. All 100 are without `expect:`, because there is no OpenAPI document to take a status from. They were not kept, because they could not run (below).

### What the schemas ask the owner

These are the questions the tester's schemas carry in their `description` fields. The rows mean nothing until they are answered, which is why a person reviews the schema and the recipe, never the rows.

| Question | From |
|---|---|
| `Description` has no stated length; 200 is a guess | RULE-011 |
| Must `MaxStockThreshold` be at least `RestockThreshold`? RULE-022 says there is no cross-field rule, so the recipe has no row for it | RULE-022 |
| RULE-015 says CSV rows skip the 50-character name limit, but RULE-011 says the database enforces it. Which is right for the import? | RULE-011, RULE-015 |
| Brand ids 1 to 5 and type ids 1 to 4 are the seed's (RULE-030). A row with id 6 tests "unknown brand", but only on a database seeded that way | RULE-012, RULE-030 |
| The price message says "positive" but 0 is accepted; a brand-not-found error reports the type name. Both are suspected defects in the rules file, not findings from a run | RULE-013, RULE-015 |

### What we learnt

| What happened | What we did |
|---|---|
| The rows could not be sent. `/Catalog/Create` takes a form (`application/x-www-form-urlencoded`) with an anti-forgery token from the Create page (RULE-009); the cases send JSON. The customisation import takes a whole file at start-up, not a request | **Fixed in 0.5.0 (#55):** `body_form` posts a row as a browser would, and `before` reads the page first for the token and the cookies; part 5 below. A file an adapter puts in place before a run is part of #51 |
| The row that breaks a `pattern` was `\u0000pattern-breaker\u0000`: right, and unreadable in a CSV, a workbook or a report | **Fixed:** a printable string the pattern refuses, `!!! not a match` |
| RULE-015's lookups are case-sensitive, and no row tried `mug` for `Mug` | **Fixed:** every string enum gets a row with a listed value in another case |
| A CSV import takes one file per condition, and the make wrote one JSON per row and one CSV for all of them | **Fixed:** `rows/<name>.csv`, the data columns alone |
| In a CSV, `null`, an empty string and a missing value all look like an empty cell, so `availablestock_null` and a pairwise row that leaves `availablestock` out are the same file | **Follow-up:** a recipe for a CSV or fixed-width shape should fold those into one row (#50) |
| Rows for the Create form are what the form posts, with the brand as an id. Rows for the import are what the CSV holds, with the brand as a name. The same item needs two schemas, one per surface | Expected: one recipe per surface, as the skill says |

The try took about ten minutes, most of it writing the two schemas from the rules. Generation and checking took seconds.

## Part 5: the rows posted to the Create form (prepared 25 October 2026)

cmtk 0.5.0 added what part 4 lacked: `body_form`, which posts a row's fields the way a browser posts a form, and `before`, which reads a page first for its anti-forgery token and cookies. The eShop files are ready and **have not been run yet**; this part is written up when they have.

What is in the folder:

- `tester\cmtk-forms.yaml`: its own settings, with `allow_unsafe_methods: true` because the Create form is a POST, and its own evidence folder, so the signed reports are never replaced.
- `tester\cmtk\cases-forms\data-catalog-item-invalid.yaml` (47 drafts) and `data-catalog-item-valid.yaml` (49 drafts), from `cmtk data cases catalog-item --encoding form --before-get /Catalog/Create --take "__RequestVerificationToken=input[name=__RequestVerificationToken]" --expect-valid 302 --expect-invalid 200 --rows invalid|valid`. The two statuses are RULE-009's: an invalid item is shown again with no write; a valid one is saved and redirects to Index. Every draft note says where they came from and that the request changes data.
- Three rows the recipe has were left out, and the tool said why: `body_not_an_object` (a form is named fields), and `Name_wrong_type`, `Description_wrong_type` and `PictureFileName_wrong_type`, because every form value is text, so a text field cannot have the wrong type. That is a difference between a JSON API and a form that the recipe cannot know and the case writer must.
- `10-data-forms.cmd`: regenerates the rows, runs `cmtk review` for the drafts, then runs the invalid rows only, which write nothing. `-Valid` adds the rows RULE-009 says are saved, into the scratch catalog.

Against a stand-in for the form (a small server that sets the cookie, renders the hidden token, and refuses a post without both), all 47 invalid cases read the page, posted with the right cookie and token, and were answered; the evidence named the page, the token field and the cookies, and held no value of either.
