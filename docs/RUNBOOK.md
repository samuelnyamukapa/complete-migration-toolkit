# Runbook: testing a system, step by step

Follow these steps in order. Each one says what to do, what you should see, and what to do if you don't. You need Node.js 22.5 or later.

## Part 1: test one system against its requirements

1. **Start the system you want to test.** Note its address, for example `http://localhost:5002`.

2. **Create the settings.** In the project folder, run:

   ```sh
   cmtk init --candidate http://localhost:5002
   ```

   - **You should see:** `Wrote cmtk.yaml, cmtk/cases/example.yaml and cmtk/drift.yaml.`
   - **If it says cmtk.yaml already exists:** the project is already set up. Open `cmtk.yaml` and check the address instead.

3. **Write one case per acceptance criterion.** Copy `cmtk/cases/example.yaml` and edit it. For each acceptance criterion, write:
   - a `requirement` (the story and criterion, such as `STORY-12/AC-1`);
   - the `request` (such as `GET /api/orders/42`);
   - what you `expect` (status, JSON values, text in the body).

   An AI agent can draft these from the stories. You then check them, because they become the definition of correct.

4. **If a request needs a login token,** never write the token into a file. Add `headers_from_env: { Authorization: CMTK_TOKEN }` to `cmtk.yaml`, then set the variable in your terminal:
   - PowerShell: `$env:CMTK_TOKEN = "Bearer …"`
   - bash: `export CMTK_TOKEN="Bearer …"`

5. **Run it:**

   ```sh
   cmtk run
   ```

   - **You should see:** a verdict (PASS, FAIL, INCOMPLETE or NO EVIDENCE), the counts, any failures, and the path of the report.
   - **FAIL:** read the failures. Either the system is wrong (raise a defect), or the expectation is wrong. Only the person who owns the requirement changes an expectation.
   - **INCOMPLETE:** some cases were skipped or could not run, or you ran only some cases with `--only`. The report says why for each one. A skipped POST, for example, needs step 6.
   - **NO EVIDENCE:** nothing could be checked. The line after the verdict says why: no cases yet, or the system did not answer.

6. **Requests that change data** (POST, PUT, PATCH, DELETE) only run against disposable test data. If that is true for this system, set `allow_unsafe_methods: true` in `cmtk.yaml` and run `cmtk run --allow-unsafe`.

7. **Read the report** at `cmtk/evidence/run/REPORT.md`. It lists every requirement with its passed and failed cases.

8. **Sign it,** if you are the person who accepts the result:

   ```sh
   cmtk signoff run
   ```

   It shows the verdict, then asks for your name, role and decision. It only works in a terminal, typed by a person, and it will not sign a report with no evidence. It records a fingerprint of the evidence, so `cmtk status` says "no longer counts" if anything in the folder changes, and running again clears the signature.

## Part 2: compare a migrated system with the old one

1. **Start both systems,** for example the legacy one on `http://localhost:5001` and the new one on `http://localhost:5002`.

2. **Make sure `cmtk.yaml` names both** under `targets:` as `legacy` and `candidate`. With a new project, `cmtk init --legacy <url> --candidate <url>` does this.

3. **Add cases.** The cases from Part 1 work as they are. You can also record real use of the legacy system:
   1. In the browser, open the developer tools, use the old system, then export the traffic from the Network tab with Export HAR.
   2. Save the file in the project folder.
   3. Run `cmtk import-har recording.har`. Cookies, tokens, API keys, images and duplicates are left out, and passwords or tokens in a query string or a request body become `REDACTED`.
   4. If it says it replaced values with REDACTED, open those cases and put in test values, or set up `headers_from_env` for them.

4. **List the contracts consumers rely on** under `contracts:` in `cmtk.yaml`: the OpenAPI JSON and any WSDL, each at its path on both systems. Contracts are locked: every change, even an added operation, shows as a difference until a named person approves it in the drift ledger.

5. **Run the comparison:**

   ```sh
   cmtk compare
   ```

6. **Go through every difference** in `cmtk/evidence/compare/REPORT.md`. Each one is one of three things:
   - **Noise** (a timestamp or an ID that changes on every call): the report lists likely ones under "Probably noise". Add the path under `scrub:` in `cmtk.yaml`, but only if you agree, because a scrub hides that value from every later run.
   - **An intended change** (a fix, or a format change consumers accepted): a named person adds it to `cmtk/drift.yaml` with an id, the `where` from the report, a reason and their name.
   - **A defect in the new system:** fix the new system.

   Run `cmtk compare` again after every change.

7. **The verdict tells you where you stand:**

   | Verdict | Meaning |
   |---|---|
   | PARITY | No differences at all |
   | DRIFT ONLY | Only approved differences |
   | NO PARITY | At least one unexplained difference, or a breaking contract change |
   | INCOMPLETE | Something could not be checked; the report says what |

8. **Sign it** with `cmtk signoff compare`.

## When something goes wrong

| You see | Do this |
|---|---|
| `cmtk: cmtk.yaml does not exist` | Run the command from the project folder, or pass `--manifest <path>` |
| `ECONNREFUSED` in a case | The system is not running at that address. Start it, or correct `base_url` |
| `the environment variable … is not set` | Set it in this terminal (step 4 of Part 1) |
| Many differences in the same field, on every case | Probably noise: see step 6 of Part 2 |
| `Sign-off is for a person at a keyboard` | Run `cmtk signoff` yourself, in a terminal |
| `holds a line break or another control character` | The token variable has a stray newline: set it again, for example with `$env:CMTK_TOKEN = "Bearer …"` |
| `leads outside the project folder through a link` | `evidence` (or a case file) points through a link to another folder. Use a folder inside the project |
