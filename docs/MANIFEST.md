# Settings and case files

## cmtk.yaml

`cmtk init` writes a commented starting point. Every relative path is resolved from the folder `cmtk.yaml` is in, and none may leave it.

| Key | Default | Meaning |
|---|---|---|
| `system` | (required) | A name for the system under test |
| `targets` | (required) | Name to `{ base_url }`. A string is accepted as the URL. A target reached only through an adapter, such as a class library or a queue, can leave out `base_url` and give its adapter settings instead: `{ probe: probes/legacy.exe }`. Every setting is passed to the adapter as part of `target` |
| `default_target` | `candidate`, or the first | The target `cmtk run` uses |
| `reference` | `legacy`, if present | `cmtk compare`'s reference: today's system |
| `candidate` | `candidate`, if present | `cmtk compare`'s system under test |
| `match` | `exact` | `exact`, `semantic` or `contract`, for every case |
| `overrides` | `[]` | `{ path: "/api/admin/*", match: semantic }`: a level for the paths a glob matches |
| `scrub.json_paths` | `[]` | JSON paths replaced before comparing, such as `$..generatedAt` |
| `scrub.xml_ignore` | `[]` | XML element names whose content is not compared |
| `scrub.regex` | `[]` | `{ pattern, replace? }` applied to text on both sides |
| `compare_headers` | `[content-type]` | Response headers compared |
| `contracts` | `[]` | `{ name, kind: openapi \| wsdl \| xsd \| text, path }`, served by both systems |
| `cases` | `[cmtk/cases/*.yaml]` | A glob, or a list of globs, of case files |
| `drift` | `cmtk/drift.yaml` | The drift ledger |
| `evidence` | `cmtk/evidence` | Where answers and reports are written. Each run replaces its own folder once it has finished. It cannot be the project folder itself |
| `allow_unsafe_methods` | `false` | Allow POST, PUT, PATCH and DELETE, with `--allow-unsafe` on the run |
| `headers_from_env` | `{}` | Header name to environment variable name; read at run time, never written |
| `timeout_s` | `30` | Per request: the whole answer must arrive within it |
| `insecure_tls` | `false` | Accept self-signed certificates, for test systems only |
| `proposals` | `cmtk/proposals.yaml` | Agents' proposals (scrubs, drift, defects, new expectations) waiting for a person. Only `cmtk review` decides them. Draft cases a person rejects are kept, with the reason, in `rejected.yaml` in the same folder |
| `explore_requests_per_day` | `1000` | The most requests exploration may send in one day (UTC), across all sessions. An open session counts its whole budget |
| `adapters` | `{}` | Surface name to `{ command, args, timeout_s, covers }`. `timeout_s` (default 300) is the longest wait for one answer. `covers` lists the kinds of boundary it checks, for `cmtk discover`. See [ADAPTERS.md](ADAPTERS.md) |

## Case files

A case file holds `cases:`, a list. Each case:

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | Unique across all case files, ignoring case: letters, digits, `.`, `-`, `_`. Not a name Windows reserves, such as `CON` or `NUL` |
| `name` | no | What the case checks, in words |
| `requirement` | no | One id or a list, such as `STORY-12/AC-1`. Reports group results by it |
| `request` | yes | `GET /path`, or `{ method, path, headers, body }`. A path, never a host. A `body` written as a YAML mapping or list is sent as JSON. Instead of `body`: `body_file`, a file inside the project sent byte for byte (the content type from the headers or the file's extension), or `files`, a list of `{ field, path, filename?, content_type? }` sent as `multipart/form-data`. The evidence records each file's SHA-256, never its bytes |
| `expect` | for `cmtk run` | What the answer must hold (below) |
| `surface` | no | The adapter that runs it. Default `http` |
| `match` | no | This case's level, overriding everything else |
| `safe` | no | `true` when a person has confirmed a non-GET request changes nothing, such as a read-only SOAP call |
| `draft` | no | `true` for a case an agent wrote that no person has accepted yet. It is reported as SKIPPED until `cmtk review` accepts it |
| `draft_note` | no | Why the drafter wrote it this way, and any question for the reviewer. Kept as `note` when a person accepts the draft |
| `note` | no | Where the case came from and what it depends on, in words |
| `accepted_by`, `accepted_on` | no | Written by `cmtk review` when a person accepts a draft |

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
| `body encoding` | One system sent UTF-8 and the other did not (checked at `exact`) |
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

`cmtk data make` writes `rows.json`, `rows/<name>.json` (one file per row, for `body_file`), `rows.csv` (UTF-8 with a BOM, CRLF), `rows.xlsx` on request (its metadata pinned to the recipe's clock, so it never names a person), `DATA.md` and `MANIFEST.json` (seed, clock, versions, every file's SHA-256, the quota results). `cmtk data cases` writes one draft case per row.
