# Settings and case files

The formats here are frozen by [FORMATS.md](FORMATS.md), and `schemas/` lets an editor check them as you type.

## cmtk.yaml

`cmtk init` writes a commented starting point. Every relative path is resolved from the folder `cmtk.yaml` is in, and none may leave it.

| Key | Default | Meaning |
|---|---|---|
| `system` | (required) | A name for the system under test |
| `targets` | (required) | Name to `{ base_url }`. A string is accepted as the URL. A target reached only through an adapter, such as a class library or a queue, can leave out `base_url` and give its adapter settings instead: `{ probe: probes/legacy.exe }`. Every setting is passed to the adapter as part of `target`. A target may list what it offers with `surfaces: [http, catalog]` (see [One manifest or two](#one-manifest-or-two)) |
| `adapter_registries` | none | Name to a git address or a folder, for `cmtk adapter add`. A folder may be outside the project. An address holding a credential is refused. See [private registries](ADAPTER-CONTRIBUTING.md#private-registries) |
| `default_target` | `candidate`, or the first | The target `cmtk run` uses |
| `reference` | `legacy`, if present | `cmtk compare`'s reference: today's system |
| `candidate` | `candidate`, if present | `cmtk compare`'s system under test |
| `match` | `exact` | `exact`, `semantic`, `contract`, `journey`, `structure` or `visual`, for every case (see [Match levels](#match-levels)) |
| `overrides` | `[]` | `{ path: "/api/admin/*", match: semantic }`: a level for the paths a glob matches |
| `visual_tolerance` | `0` | At `visual`: the share of a screenshot's pixels that may change, from 0 to 1 |
| `scrub.json_paths` | `[]` | JSON paths replaced before comparing, such as `$..generatedAt` |
| `scrub.xml_ignore` | `[]` | XML element names whose content is not compared |
| `scrub.regex` | `[]` | `{ pattern, replace? }` applied to text on both sides |
| `compare_headers` | `[content-type]` | Response headers compared |
| `contracts` | `[]` | `{ name, kind: openapi \| wsdl \| xsd \| text, path }`, served by both systems; or `{ name, kind: assembly, legacy, candidate, types, namespace_map }`, read from files through REA ([below](#assembly-contracts)) |
| `cases` | `[cmtk/cases/*.yaml]` | A glob, or a list of globs, of case files |
| `drift` | `cmtk/drift.yaml` | The drift ledger |
| `known_issues` | `cmtk/known-issues.yaml` | The known-issues ledger: failures of `cmtk run` a named person accepted |
| `evidence` | `cmtk/evidence` | Where answers and reports are written. Each run replaces its own folder once it has finished. It cannot be the project folder itself |
| `evidence_history` | off | `{ dated: true, keep_days: 90, keep_runs: 30, max_mb: 1024 }`: keep every run in a dated folder, and the rule for removing old ones. `dated` is off by default; `--dated` does the same for one run. `keep_days` defaults to 90, `max_mb` to 1024, and `keep_runs` to no limit. See [TRENDS.md](TRENDS.md) |
| `allow_unsafe_methods` | `false` | Allow POST, PUT, PATCH and DELETE, with `--allow-unsafe` on the run |
| `headers_from_env` | `{}` | Header name to environment variable name; read at run time, never written |
| `timeout_s` | `30` | Per request: the whole answer must arrive within it |
| `insecure_tls` | `false` | Accept self-signed certificates, for test systems only |
| `proposals` | `cmtk/proposals.yaml` | Agents' proposals (scrubs, drift, known issues, defects, new expectations, locator repairs) waiting for a person. Only `cmtk review` decides them. Draft cases a person rejects are kept, with the reason, in `rejected.yaml` in the same folder |
| `explore_requests_per_day` | `1000` | The most requests exploration may send in one day (UTC), across all sessions. An open session counts its whole budget |
| `compare_only_surfaces` | `[]` | Surfaces whose cases exist only to compare two systems, usually with no `expect:`. `cmtk run` leaves them out and its reason says how many |
| `adapters` | `{}` | Surface name to `{ command, args, timeout_s, covers }`. `timeout_s` (default 300) is the longest wait for one answer. `covers` lists the kinds of boundary it checks, for `cmtk discover`. See [ADAPTERS.md](ADAPTERS.md) |

## Case files

A case file holds `cases:`, a list. Each case:

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | Unique across all case files, ignoring case: letters, digits, `.`, `-`, `_`. Not a name Windows reserves, such as `CON` or `NUL` |
| `name` | no | What the case checks, in words |
| `requirement` | no | One id or a list, such as `STORY-12/AC-1`. Reports group results by it |
| `request` | yes | `GET /path`, or `{ method, path, headers, body }`. A path, never a host. A `body` written as a YAML mapping or list is sent as JSON. Instead of `body`: `body_file`, a file inside the project sent byte for byte (the content type from the headers or the file's extension); `body_form`, a form (below); or `files`, a list of `{ field, path, filename?, content_type? }` sent as `multipart/form-data`, with `body_form`'s fields as its text parts when both are given. The evidence records each file's SHA-256, never its bytes |
| `request.body_form` | no | The fields of a form, sent as `application/x-www-form-urlencoded` the way a browser posts one: a JSON file inside the project whose top-level fields are the form (one of `cmtk data make`'s row files), or a mapping written inline. A field holds text, a number, a boolean (`true`/`false`), null (an empty value, as an empty input) or a list of those (repeated fields); an object is refused |
| `request.before` | no | `{ get: /a/path, take?: { field: selector } }`: a page on the same target read before the request, for the cookies it sets (all go on the request) and the values it carries, each put into a form field. A selector is `input[name=x]` (its `value`), `meta[name=x]` (its `content`), `tag[attr=x]@attr`, `regex:<pattern with one group>` or `cookie:<name>`. This is how a form with an anti-forgery token is posted. The values taken are never written to evidence; their names, the page and its status are. A page that doesn't answer 2xx, or a selector that matches nothing, makes the case an error and the request is not sent |
| `expect` | for `cmtk run` | What the answer must hold (below) |
| `surface` | no | The adapter that runs it. Default `http` |
| `journey` | no | For the [web adapter](../adapters/web/README.md): a task written as steps, with checks in code |
| `mask` | no | For the web adapter: locators of areas painted over in screenshots, such as a clock |
| `match` | no | This case's level, overriding everything else |
| `safe` | no | `true` when a person has confirmed a non-GET request changes nothing, such as a read-only SOAP call |
| `draft` | no | `true` for a case an agent wrote that no person has accepted yet. It is reported as SKIPPED until `cmtk review` accepts it |
| `draft_note` | no | Why the drafter wrote it this way, and any question for the reviewer. Kept as `note` when a person accepts the draft |
| `note` | no | Where the case came from and what it depends on, in words |
| `accepted_by`, `accepted_on` | no | Written by `cmtk review` when a person accepts a draft |
| `expect_draft` | no | `true` for an `expect:` block drafted from a recording (`cmtk import-har --draft-expect`) that no person has confirmed. `cmtk run` reports the case as SKIPPED, "draft expectation: review it", and `--accepted-only` leaves it out. `cmtk compare` never reads `expect`, so it still compares the case |
| `expect_confirmed_by`, `expect_confirmed_on` | no | Written by `cmtk review` when a person confirms a drafted expectation |

### expect

```yaml
expect:
  status: 200                   # or a list: [200, 204]
  headers:
    Content-Type: { matches: "json" }
  json:
    "$.count": { equals: 12 }
    "$.items[*].name": { type: string }       # string, number, boolean, object, array or null
    "$.error": { exists: false }
    "$.id": { matches: "^ORD-[0-9]+$" }
  body_contains: ["Thank you for your order"]
  body_excludes: ["Exception", "at System."]   # text that must never appear, such as a stack trace
```

Cases run in file order, but each case must stand alone: a case never depends on what an earlier one did.

A check on a path that matches several values (with `[*]` or `..`) must hold for each of them.

## Match levels

| Level | Compares | For |
|---|---|---|
| `exact` | Status, the headers in `compare_headers`, effects and the body, byte for byte after scrubs | A system that must not change at all |
| `semantic` | The same, ignoring number format, key order and whitespace | A rebuild that may format its answers differently |
| `contract` | Status only | A rough check, with the contract files doing the rest |
| `journey` | The goal, each check's result, the key values and the named pages, from an adapter's `journey` report. Paths, status, styling and screenshots may differ. API calls are compared only when the journey sets `compare_api: true` | A new UI: the same goals reached with the same outcomes, whatever the screens look like |
| `structure` | Status, and each page's accessibility tree: the same elements, labels and order. Styling may differ. `scrub.regex` applies to names and values, for content that changes such as dates and prices | A reskin |
| `visual` | `structure`, and each screenshot pixel by pixel, with masks painted over changing areas. Compare on one machine with one browser version: fonts and drawing differ between machines | An upgrade where the look must stay the same |

A level that finds nothing to compare never reads as a match. An adapter that reports no journey at `journey`, or a journey with no checks, values or named pages, reads as a difference at `journey`. No structure at `structure` reads as a difference at `structure`, and no screenshot at `visual` as a difference at `visual`.

## Drift ledger (cmtk/drift.yaml)

```yaml
drift:
  - id: DRIFT-001
    case: "*"                    # or one case id
    where: "header:content-type" # copied from the report; JSON paths may use [*]
    reason: charset now added; consumers ignore it
    approved_by: Jane Smith
    date: 2026-10-16
```

Every entry needs `id`, `where`, `reason` and `approved_by`. A `where` that starts with `$` (or `effects:$`) is a JSON path, so `[*]` and `..` work. Any other `where` is matched as written, with `*` matching any text: `/Envelope/Body/Item[*]/text()`, or `contract:catalog-api: operation added: *`.

The report lists any entry that no longer matches anything, so stale approvals do not pile up. After a partial run (`--only`), it lists only entries for the cases that ran.

## Known-issues ledger (cmtk/known-issues.yaml)

Some failures must stay for now. A legacy defect is the usual one: the rule is to match legacy first, so the case must not be changed to hide it. The ledger records such a failure once, with the person who accepted it, so that `cmtk run` can tell it apart from a new failure.

```yaml
known_issues:
  - id: LEG-1
    case: API-2-01               # one case id, never a wildcard
    fails:                       # copied from the report's Failures table
      - { check: status, expected: "200", actual: 404 }
      - { check: body, expected: JSON }
    reason: the route was never registered; match legacy first
    accepted_by: Jane Smith
    date: 2026-10-18
    target: legacy               # optional: only on this target
```

Every entry needs `id`, `case`, `fails`, `reason` and `accepted_by`. Each item in `fails` needs `check`; `expected` and `actual` are matched exactly when given, and `cmtk check` warns about an item with neither, because it would accept any answer at that check.

- **Only a person adds an entry.** The ledger refuses an entry with no `accepted_by`, or one that names an agent. An agent proposes one with `cmtk_propose` (kind `known_issue`), and a person accepts it with `cmtk review`, which writes the entry with their name.
- **It never hides a failure.** The case still reads `FAIL (known issue LEG-1)`, its requirement still shows a failure, and the report lists the ledger. It is not counted as passed, and `cmtk defects` does not draft it again.
- **It covers only what it describes.** A case fails as a known issue only when every one of its failures is in the ledger. If `GET /api` starts to answer 500 where the entry says 404, that is an ordinary FAIL.
- **Stale entries are reported.** An entry whose case passes, or fails some other way, or no longer exists, is listed under "No longer failing". A case that did not run, or that `--only` left out, says nothing about its entry.
- **`cmtk run` only.** `cmtk compare` does not read this ledger. A difference between two systems is approved in the drift ledger.

| Verdict | Means | Exit code |
|---|---|---|
| PASS WITH KNOWN ISSUES | Every failure is in the ledger, and every other case passed | 4 |
| FAIL | At least one failure is not in the ledger | 1 |
| INCOMPLETE | Some cases were skipped or could not run, `--only` was used, or an answer was over 5 MB so only its first 5 MB were checked; and nothing new failed | 2 |

Exit code 4 is on purpose not 0. A pipeline written before this verdict stops and a person looks; a pipeline that accepts it says so (see [TESTER-RUNBOOK.md](TESTER-RUNBOOK.md)). It is also not 1, so a known issue is told apart from a new failure. A person can sign the report, and the signature records which known issues still fail and who accepted them.

## One manifest or two

A partly rebuilt system often has surfaces the new one does not have yet. One manifest can hold them all: each target lists what it offers.

```yaml
targets:
  legacy:    { base_url: "http://localhost:53190", probe: probe/net472.exe, surfaces: [http, catalog] }
  candidate: { probe: probe/net8.exe, surfaces: [catalog] }
compare_only_surfaces: [catalog]
```

A target that lists nothing takes part in every case, as before.

| Command | A case on a surface the target has | A case on a surface a target lacks |
|---|---|---|
| `cmtk compare` | Sent to both systems and compared | Nothing is sent. It reads "not comparable: candidate has no http surface". It is not an error |
| `cmtk run` | Sent to the target | Nothing is sent. It is SKIPPED, so the verdict is INCOMPLETE: a requirement was not checked on that target |

`compare_only_surfaces` is for cases with no `expect:`, written only to be compared. Without it `cmtk run` would skip each one, and could never pass on this manifest.

**A comparison of part of a system never reads as parity.** When a target lists its surfaces, the report has a Scope section saying what was compared and what was not, and the reason repeats it. The verdict is decided in this order:

| Verdict | Means | Exit code |
|---|---|---|
| NO PARITY | An open difference on what was compared. The scope is stated too | 1 |
| NO EVIDENCE | Nothing could be compared | 2 |
| INCOMPLETE | A case was skipped or could not run | 2 |
| PARTIAL COMPARISON | No open difference, but a surface a target lists was not compared, because the other target lacks it or no case covers it; or a contract could not be compared; or an answer was over 5 MB, so only its first 5 MB were compared | 4 |
| PARITY or DRIFT ONLY | Every surface the targets list was compared | 0 |

The word PARITY is left out of PARTIAL COMPARISON on purpose, so that nobody reads, or searches for, parity in it. The exit code is 4 for the same reason: a pipeline that gates a release on parity does not pass on a partial comparison. A person can sign one, and the signature records the scope, so it covers what was compared and nothing else.

**Use one manifest** when both systems are the same migration, and the difference is only how far the rebuild has reached. You get one report that shows the gap, and the gap closes as the candidate adds surfaces.

**Use two manifests** when the settings must differ: another match level, other scrubs or another drift ledger for each part, or two comparisons with different reference systems. Then each report covers its own part, and neither says what the other left out, so list the gap in your pilot's write-up. A target with no `surfaces` in such a manifest reads PARITY for what its cases cover: list `surfaces` if it covers only part of the system.


## Assembly contracts

A class library has no URL, so its contract is read from the files. Neither build is run.

```yaml
contracts:
  - name: catalog-service
    kind: assembly
    legacy: legacy/bin/eShopLegacyMVC.dll     # or REA's saved output, ending .json
    candidate: rebuilt/bin/CatalogCore.dll
    types: [eShopLegacyMVC.Services.ICatalogService, eShopLegacyMVC.Models.*]
    namespace_map: { eShopLegacyMVC: CatalogCore }
```

`cmtk compare` runs `rea inspect-managed-members` on each build (`npm install --global rea-agents`), or reads the saved output. It compares the public and protected methods and fields of the listed types, after the map. The longest match in the map wins.

| Finding | Result |
|---|---|
| A type or member removed, or a signature changed | `BREAKING` |
| A type or member added | `COMPATIBLE`. It still needs approval, like every contract change |
| A signature that can't be proved unchanged | `REVIEW`, for a person |

REA writes a referenced type (`IList<T>`) as a number that means nothing in another build, and it does not list what the number stands for. So cmtk tries likely names against REA's digest of the signature, and uses a name only when the digest matches. Add names of your own under `known_types`. A signature it still can't prove is a `REVIEW` finding, never "unchanged".

Findings are approved like drift: `contract:<name>: <finding>` in the drift ledger. If REA is missing or a file can't be read, the contract's result is `ERROR` and the verdict is `INCOMPLETE`.

## Where values in a report come from

| `where` | Meaning |
|---|---|
| `status` | The HTTP status |
| `header:<name>` | One response header |
| `$.a.b[0]` | A JSON body value |
| `/Envelope/Body/X/text()` | An XML or SOAP value, by element name, ignoring prefixes. Around child elements, `text()[2]` is the second run of text |
| `/Envelope/Body/X[2]` | An element that only one system sent, by position |
| `body line N` | The first differing line of a text body |
| `effects:$.emails[0].subject` | A side effect an adapter reported |
| `journey:check:<name>` | A check in a journey that passed on one system only |
| `journey:value:<name>` | A key value a journey read |
| `journey:page:<name>`, `journey:pages` | A named page reached on one system only, or reached in another order |
| `journey:api:<method> <path> <status>` | An API call made a different number of times, when the journey asks to compare them |
| `structure:/shop button "Buy"` | An element on one system only, by page, role and name. A repeated element reads `button "Buy" [2]` |
| `structure:/shop button "Buy" (moved)` | The element is on both systems, in another order |
| `structure:/shop textbox "Email" required` | A fact about an element: `level`, `value`, `required`, `disabled`, `checked` or `readonly` |
| `structure:/shop` | A page reached on one system only |
| `visual:/shop`, `visual:/shop size` | A screenshot that differs after its masks, or by size |
| `journey:goal`, `journey` | The journeys have different goals, or an adapter reported nothing to compare |
| `body encoding` | One system sent UTF-8 and the other did not (checked at `exact`) |
| `not comparable: <target> has no <surface> surface` | Not a `where`, but a result: a target lacks the case's surface, so nothing was sent |
| `contract:<name>: <finding>` | A change to a contract, such as `contract:catalog-api: operation added: GET /api/v2/items`. Every change needs approval, additions included, because contracts are locked by default |

## Test-data recipes (cmtk/data/*.yaml)

`cmtk data plan` writes a recipe from a JSON Schema or an OpenAPI operation; `cmtk data make` regenerates its rows. A person reviews the recipe, never the rows.

| Key | Meaning |
|---|---|
| `id` | The recipe's name; its rows go in `cmtk/data/<id>/` |
| `draft` | `true` for a recipe an agent wrote |
| `seed`, `clock`, `locale` | What every random, date and realistic value is derived from. The same seed gives the same rows on Windows and Linux |
| `source` | The schema file, its SHA-256 and, for OpenAPI, the operation. A changed file is refused until the recipe is planned again |
| `generators` | The versions that made the rows: a different version may make different values from the same seed |
| `quotas` | `max_happy_share` (default 0.5): at most this share of rows may be happy paths; `boundaries_on_every_ordered_field`; `negative_for_every_field`. A recipe that breaks them is reported |
| `fields` | One per field: `path`, `type`, `required`, `nullable`, `constraints`, `source` (which part of the schema), `valid_from` (how a valid value is made), `note` |
| `rows` | One per condition. `name` says what it exercises; `technique` is `EP`, `BVA-3`, `pairwise` or `hostile`; `coverage_item` says it in words; `expect_valid` is what the schema says; `invalid_because: { path, keyword }` is confirmed by the validator; `oracle` is `specified`, `derived`, `implicit` or `human`; `set` and `unset` change the generated baseline by JSON path; `replace_body` replaces it |

`cmtk data make` writes `rows.json`, `rows/<name>.json` (one file per row, for `body_file`), `rows.csv` (UTF-8 with a BOM, CRLF) and `rows/<name>.csv` (one row's data columns alone: the file an import takes for that one condition), `rows.xlsx` on request (its metadata pinned to the recipe's clock, so it never names a person), `DATA.md` and `MANIFEST.json` (seed, clock, versions, every file's SHA-256, the quota results). `cmtk data cases` writes one draft case per row: `--encoding form` sends the row as a form (`body_form`) rather than a JSON body, `--before-get /page --take field=selector` adds the page to read first, `--rows invalid` keeps only the rows the schema calls invalid (the ones a form answers without writing), `--only-rows` and `--except-rows` pick rows by name (for a rule the test environment cannot enforce, such as a database limit against a mock, whose rows belong in another file), and `--expect-valid` / `--expect-invalid` give the statuses when no document does; the draft note says they came from the command line, so the reviewer checks them against the requirement.

### What an agent may add

`/cmtk:data` proposes what a schema can't say, with `cmtk_data_propose`. A proposal says who says so (`structure`, `spec` or `production`), gives its evidence, and waits for `cmtk review`. It holds no rows and no answers.

| `what` | When a person accepts it |
|---|---|
| `invariant` | Every valid row stays on the right side of `$.end >= $.start`, or `$.total` as the `sum` of `$.lines[*].amount`. The engine adds one row exactly at the edge and one broken by a step. A row it can't keep on the right side becomes a labelled negative, and the reply says how many |
| `vocabulary` | Realistic values for text the schema says nothing about, each checked by the validator. The field stays marked `low_confidence` |
| `notional`, `state_machine` | Recorded in the recipe with who said so. No row or sequence is made from them yet |
| `mutation` | One of the engine's operators on a field. The engine makes the row, and the validator says if it is valid. The gate refuses a row that adds no coverage, at the proposal and again at acceptance. Its oracle is `human`, so it never gets an `expect:` automatically |

Where the sources disagree, `cmtk_data_finding` records what each says and the question, in `cmtk/data/<id>.findings.yaml`. It settles nothing. `cmtk data traffic <id> --har <file>` shows what a recording says against the schema, as paths, counts and reasons, never a value.

### Files from a recipe

`cmtk data make <id> --format <list>` writes what a system's import or batch job needs. Every file comes from the recipe, so the same recipe gives the same bytes (CSV, fixed-width) or the same content (Excel). A workbook never holds a real name or today's date: its `creator` and `lastModifiedBy` are `cmtk`, and its dates are the recipe's clock.

| Format | Writes |
|---|---|
| `json`, `csv`, `xlsx` | `rows.json`, `rows.csv`, one file per row, `rows.xlsx` |
| `fixed` | `records.dat` and `layout.json`, for a recipe planned from a copybook. The length of the file is checked to be a multiple of the record size, and every record is read back. A row a record can't hold (an emoji in EBCDIC) is left out, and `DATA.md` says which and why |
| `edge-csv` | `edge/csv/`: empty, header only, one row, the most rows and one more, CRLF, LF, UTF-8 with and without a BOM, Latin-1, semicolons, a line break in a cell, and each OWASP injection character |
| `edge-xlsx` | `edge/xlsx/`: merged cells, formulas with and without a stored value, a workbook named `.csv`, CSV named `.xlsx`, and a corrupted file |
| `edge-fixed` | `edge/fixed/`: sign nibbles, valid and not; `OCCURS DEPENDING ON` out of range; a truncated file |

Each edge file is labelled in `DATA.md` and `MANIFEST.json` with what it exercises and whether the format allows it. What the system should answer comes from the requirement or the legacy system.

In a recipe, `csv:` sets `delimiter`, `quote`, `quoted`, `header`, `bom`, `line_ending` (`crlf` or `lf`) and `max_rows`, and `xlsx: { formulas: value | formula }` says whether a text cell that starts with `=` is written as text or as a formula. Excel files use the 1900 date system, and say so.

A copybook (`.cpy`, `.cbl`, `.cob`) works as `--schema`, with `--record-encoding cp037` (the default) or `ascii`. It takes the same boundaries and negatives as JSON. `PIC X`, `A`, `9`, `S`, `V`, `COMP`, `COMP-3`, `SIGN SEPARATE`, `OCCURS` and `OCCURS DEPENDING ON` are read. `REDEFINES` is noted in the recipe, and rows follow the original field. `COMP-1` and `COMP-2` are refused. Money with more than 15 digits stays as text, because a number can't hold it exactly.

### XML and SOAP

An XSD, or a single-file WSDL (`?singleWsdl`), works as `--schema`. `--operation` names the top-level element, or the WSDL's operation.

```
cmtk data plan --schema Billing.wsdl --operation GetInvoice --id get-invoice
cmtk data make get-invoice
cmtk data cases get-invoice --path /Billing.svc --requirement RULE-20
```

The rows are the same as for JSON: partitions, three-value boundaries, negatives and pairwise. `xs:pattern` is respected, and a value is made from it. Each row is written as `rows/<name>.xml`, with its namespaces, and read back and checked against the schema. XML adds rows of its own: a wrong order in a sequence, an extra element, an element that occurs twice, two branches of a choice, the wrong namespace. A row that means nothing in XML is left out, and the recipe's notes say so, because every XML value is text.

A WSDL's operation also writes `rows/<name>.soap.xml`, in a SOAP envelope, with the version and the action from its binding. For a plain XSD, `--soap 1.1 --soap-action <uri>` does the same. `cmtk data cases` sends the envelope, with the right `Content-Type` and `SOAPAction`, and `cmtk compare` compares the answers as it does any SOAP answer.

Understood: elements, `sequence`, `choice`, `all`, `minOccurs`, `maxOccurs`, attributes, `ref`, named and inline types, extensions, and the facets `length`, `minLength`, `maxLength`, `pattern`, `enumeration`, `minInclusive`, `maxInclusive`, `minExclusive`, `maxExclusive`, `totalDigits` and `fractionDigits`. Local `xs:include` and `xs:import` files are followed; nothing is fetched. `xs:group` is refused. `xs:union` and `xs:list` are treated as plain text, and the recipe's notes say so. An `xs:long` is limited to what a number holds exactly.

### Comparing files

`cmtk data diff <a> <b> --key <columns>` compares two files by what they mean. It exits 0 if they are the same and 1 if they differ. It never compares bytes.

- **CSV:** parsed, with rows matched by key. Null, empty and absent are one thing, because the format can't tell them apart. `--no-fold-empty` turns that off.
- **Excel:** each sheet to cells, with the first row as the header, by key. `--formulas formula` compares formulas rather than stored values.
- **Fixed-width:** `--as fixed --copybook <file>` decodes records first, so an EBCDIC file and an ASCII file with the same data are the same. A record that can't be decoded makes the files different.
- **Numbers:** `5`, `5.0` and `5.00` are equal, and `--epsilon 0.01` allows for rounding. `007` is an identifier, not 7.
- **`--scrub dates,guids`:** each date and GUID becomes a counter (`DATE_1`, `GUID_1`), in key order, so two runs at different times compare the same, but a row that points at the wrong row still shows.

PDF and Word files are not written or compared yet.
