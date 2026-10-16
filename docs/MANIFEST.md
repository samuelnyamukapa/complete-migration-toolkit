# Settings and case files

## cmtk.yaml

`cmtk init` writes a commented starting point. Every relative path is resolved from the folder `cmtk.yaml` is in, and none may leave it.

| Key | Default | Meaning |
|---|---|---|
| `system` | (required) | A name for the system under test |
| `targets` | (required) | Name to `{ base_url }`. A string is accepted as the URL |
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
| `cases` | `[cmtk/cases/*.yaml]` | Globs of case files |
| `drift` | `cmtk/drift.yaml` | The drift ledger |
| `evidence` | `cmtk/evidence` | Where answers and reports are written (each run replaces its own folder) |
| `allow_unsafe_methods` | `false` | Allow POST, PUT, PATCH and DELETE, with `--allow-unsafe` on the run |
| `headers_from_env` | `{}` | Header name to environment variable name; read at run time, never written |
| `timeout_s` | `30` | Per request |
| `insecure_tls` | `false` | Accept self-signed certificates, for test systems only |
| `adapters` | `{}` | Surface name to `{ command, args }`. See [ADAPTERS.md](ADAPTERS.md) |

## Case files

A case file holds `cases:`, a list. Each case:

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | Unique across all case files: letters, digits, `.`, `-`, `_` |
| `name` | no | What the case checks, in words |
| `requirement` | no | One id or a list, such as `STORY-12/AC-1`. Reports group results by it |
| `request` | yes | `GET /path`, or `{ method, path, headers, body }`. A path, never a host |
| `expect` | for `cmtk run` | What the answer must hold (below) |
| `surface` | no | The adapter that runs it. Default `http` |
| `match` | no | This case's level, overriding everything else |
| `safe` | no | `true` when a person has confirmed a non-GET request changes nothing, such as a read-only SOAP call |

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
```

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

Every entry needs `id`, `where`, `reason` and `approved_by`. The report lists any entry that no longer matches anything, so stale approvals do not pile up.

## Where values in a report come from

| `where` | Meaning |
|---|---|
| `status` | The HTTP status |
| `header:<name>` | One response header |
| `$.a.b[0]` | A JSON body value |
| `/Envelope/Body/X/text()` | An XML or SOAP value, by element name, ignoring prefixes |
| `body line N` | The first differing line of a text body |
| `effects:$.emails[0].subject` | A side effect an adapter reported |
