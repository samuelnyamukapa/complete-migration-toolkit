# Batch adapter

Copies a case's input files to a fresh working folder for each target, runs a job named in settings, and reports each output file as name, size, hash and records. It needs no packages.

CardDemo's real files are not in this repository. The samples here are small files made for the tests, not CardDemo.

## Setting up

Jobs and layouts are maps, and target settings in `cmtk.yaml` cannot hold one, so settings go in a JSON file, by target name, with `*` for all targets. Paths in it are relative to that file. See `samples/settings.json`.

```yaml
targets:
  legacy:    { label: legacy }
  candidate: { label: candidate }
allow_unsafe_methods: true   # a job is a system's own code
adapters:
  batch: { command: node, args: [adapters/batch/index.mjs, --settings, batch-settings.json], covers: [files] }
```

| Setting | What it does |
|---|---|
| `jobs` | Each job's `command`, and optional `script`, `args`, `time_limit_s` and `env_names`. Case paths name them: `/jobs/post` runs `post` |
| `layouts` | Maps an output file name (`*` allowed) to a layout file |
| `keys` | Maps an output file name to the fields that identify a record, over the layout's own `keys` |
| `outputs` | The folder inside the working folder to report. Default `out` |
| `inputs_root` | Where case inputs are read from |
| `time_limit_s` | Default 60. Keep it under the adapter's `timeout_s` |
| `max_records` | The most records to read per file. Default 10000 |
| `keep_work` | Keeps the working folder and names it on standard error, to look into a failure |

A job runs with its working folder as the current folder, its inputs in `in/`, and its outputs going to `out/`.

## A case

```yaml
- id: POST-1
  surface: batch
  request: { method: POST, path: /jobs/post }
  inputs: [input/trans.txt, { from: input/old-name.dat, as: TRANS.DAT }]
```

POST runs the job, so it needs both unsafe switches, unless a person has marked the case `safe: true`, confirming the job changes nothing outside its folder. GET, HEAD and OPTIONS only fingerprint the inputs. They do not run the job.

A job's exit code is a fact to compare, in `effects.exit_code`. A job over its time limit is stopped, and the case is an error.

## A layout file

```json
{
  "encoding": "cp037",
  "record_length": 26,
  "keys": ["account"],
  "ignore": ["run_date"],
  "fields": [
    { "name": "account", "start": 0, "length": 6 },
    { "name": "amount", "start": 6, "length": 7, "type": "zoned", "scale": 2 },
    { "name": "quantity", "start": 13, "length": 3, "type": "packed" }
  ]
}
```

- **`encoding`:** `cp037` (EBCDIC), `ascii`, `latin1` or `utf8`.
- **Records:** `record_length` for fixed blocks, or `"line_breaks": true` for one record a line, with either line ending.
- **`type`:** `text` (trailing spaces dropped), `zoned` (COBOL DISPLAY, with its sign) or `packed` (COBOL COMP-3). Numbers are reported as exact text, such as `"-42.00"`. Bytes that are not a valid number read `invalid:<hex>`.
- **`keys`:** records are reported by key, so a different order is not a difference. A key held twice keeps both.
- **`ignore`:** fields left out, such as a run date.

A file with keys or ignored fields is hashed by its records, and `hash_of` says so, since the raw bytes would differ with order or date. Any other file is hashed by its bytes. A file with no layout is reported as lines when it is text. A file that does not fit its layout gets a `problem`.

## Safety

- **Originals.** The job gets copies, in a new folder for each run on each target, which is removed afterwards. Every original is hashed before and after: if one changed, the case is an error naming it.
- **Writing outside the working folder.** Refused before the job runs: an argument, an input name or an `outputs` folder that is absolute or goes up with `..`. A link in the outputs leading outside is an error.
- **Node jobs are locked in.** They run under Node's permission model, so a write outside the working folder fails. Set `node_permission: false` for a job that needs what that blocks, such as starting another program.
- **Other programs are not locked in.** The adapter cannot stop a compiled program that ignores its arguments from writing elsewhere. Run those under an account or a container that can write nowhere else. The hash check above still catches a change to an original.
- **No shell.** Shell characters are plain text. A `.cmd` or `.bat` file is refused on Windows, because it would need a shell.
- **Secrets.** A job gets only `PATH` and a few system variables, plus any named in `env_names`. Headers are never used.
- **Too many records is an error,** with what was read kept in the evidence, so part of a file cannot count as a match.

## Tests

`npm test` runs `test/batch.test.mjs`. `cmtk adapter check batch` needs no settings: it runs the golden samples in `samples/`, whose expected reports are in `samples/golden/`, through `node` on Windows and Linux.
