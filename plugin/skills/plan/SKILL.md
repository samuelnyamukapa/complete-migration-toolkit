---
name: plan
description: "Turn user stories, acceptance criteria, a runbook, a requirements document or an OpenAPI file into a written test plan and draft cmtk case files, for a person to review. Every case traces to a requirement; anything unclear becomes a question, not a guess. Usage: /cmtk:plan <files or folder> [--topic <name>] [--scope \"<what is in and out>\"] [--manifest <file>]"
---

## Inputs

Arguments: `$ARGUMENTS`

If that line shows the literal text `$ARGUMENTS` or is empty, the skill was started from a plain-language request: take the inputs, topic and scope from the user's message. If no input is named, ask which files hold the requirements. Never invent requirements.

- **Input files**, inside the project. Any of these:
  - stories with acceptance criteria;
  - a runbook;
  - a requirements document;
  - rules extracted from code;
  - an OpenAPI (Swagger) JSON file.

  Read every one before you write anything.
- **`--topic <name>`**: a short name for this plan, such as `catalog`, used to name the files you write. Letters, digits and `-` only. If it isn't given, choose one and say which.
- **`--scope "<text>"`**: what is in scope and what is out. Without it, everything in the inputs is in scope.
- **`--manifest <file>`**: the settings file. The default is `cmtk.yaml` in the project folder; if there is none, use `/cmtk:test` first.

The **project** is the folder that holds the manifest, normally the current working directory. Pass `manifest` to every cmtk tool as the manifest's absolute path.

**Tools,** on the `cmtk` MCP server. Your own file tools write the plan and case files.

| Tool | When | Example arguments |
|---|---|---|
| `cmtk_proposals` | Before writing: to see what is pending, and what a person has already decided | `{"manifest": "/abs/cmtk.yaml", "status": "all"}` |
| `cmtk_check` | After writing: it validates the drafts and sends no requests | `{"manifest": "/abs/cmtk.yaml"}` |
| `cmtk_propose` | Only to suggest a change to an *accepted* case | `{"manifest": "…", "kind": "expectation", "case": "CAT-1-02", "expect": {"status": 404}, "reason": "…", "agent": "<your name>"}` |
| `cmtk_commands_for_person` | At the end: the exact review command for the person | `{"manifest": "…"}` |

If the `cmtk` server is not available, stop and say so.

## What you write

1. **The test plan, `cmtk/plans/<topic>.md`.** It is written for a tester to read in five minutes, and holds:
   - **criteria:** a table with one row per acceptance criterion: its id, what must be true, the case ids that check it, and whether it is automated or a manual check;
   - **cases:** for each one, the steps, the data and the expected result, in plain words;
   - **manual checks**, numbered `MAN-1`, `MAN-2` and so on: steps that need a person, or can't be expressed as a case;
   - **out of scope:** what you left out, and why;
   - **questions:** everything the inputs leave unclear.
2. **Draft cases, `cmtk/cases/<topic>.yaml`,** in the format below. Each case has:
   - `draft: true`;
   - a `draft_note` of one or two lines: the sentence of the input it comes from, and any doubt.

## Case format

```yaml
cases:
  - id: CAT-1-03                  # unique across all case files: letters, digits, . - _
    name: a page past the end is empty, not an error
    requirement: CAT-1/AC-4       # or a list, when one case checks several criteria
    request: GET /items?page=9    # or { method, path, headers, body }; a path, never a host
    expect:                       # every check is optional
      status: 200                 # or a list: [200, 204]
      headers: { Content-Type: { matches: "^application/json" } }
      json:
        "$.items": { type: array }            # string, number, boolean, object, array or null
        "$.total": { equals: 12 }
        "$.error": { exists: false }
        "$.items[*].id": { matches: "^[0-9]+$" }   # [*]: every element must pass
      body_contains: ["Showing 10 of 12"]
      body_excludes: ["Exception", "at System."]   # text that must never appear
    draft: true
    draft_note: "From RULE-004: 'pageIndex 5 returns an empty page with no error'."
```

- Cases run in file order, but each case must stand alone. A case never depends on what an earlier one did.
- If something can't be expressed with these checks (such as "sorted by name"), check what you can, and put the rest in the plan as a manual check.

## Rules

- **Expectations come from the requirement, never from the running system.** Don't call the system to see what it answers and then expect that: it would turn today's bugs into the definition of correct. For a migration, when the requirement is "behave like the old system", `cmtk compare` checks it, and those cases need no `expect:`.
- **Rules extracted from code** describe what the code does today, including its bugs, and what you do with a suspected defect depends on the project's stated intent:
  - **Behaviour must match exactly, including known quirks**, which is common for a migration (look for an intent, brief or plan that says so): pin what the rules describe, suspected defects included. Say "kept for parity" in `draft_note`, and list each one in the plan so a person can decide later to fix it as approved drift.
  - **Otherwise:** never expect a suspected defect. Turn it into a question: keep or fix?
- **Rules can describe one mode while the system runs another.** For example, a rule may describe the SQL path while the system under test uses mock data. When it matters, say which mode a rule describes. Don't state how today's system behaves unless the input says so for the mode under test.
- **Requirement ids:**
  - use the input's own ids exactly;
  - if it gives ids only to requirements, add `/AC-1`, `/AC-2` and so on per criterion;
  - if it gives none, make simple ones (`REQ-1/AC-1`).

  List the ids you made in the plan.
- **One case or more per acceptance criterion**, including the unhappy paths it implies: an unknown id, a missing field, an empty list, a value at and past each limit.
- **Everything the scope names gets at least one case**, even when the input says little about it. A case can check only the status, or have no `expect:` and a question. An area of scope with no case is a gap the reviewer won't see.
- **Always include** the system's entry point (such as `GET /`) and an unknown address (a 404).
- **If a check can be written as a case, write it as one.** For example, "the form carries an anti-forgery token" is `body_contains: ["__RequestVerificationToken"]`. Only steps that need a person, or that can't be expressed with the checks above, become manual checks.
- **A status the input implies but doesn't state**, such as 200 for an item that exists, may be expected. Say so in `draft_note`.
- **Unclear means a question, not a guess.** If a criterion doesn't say what the answer should be (which status, which message, which order?), write the question in the plan. Then either leave `expect:` out of that case or expect only what is certain, and say so in `draft_note`. `cmtk_check` warns about cases without `expect:`, which is expected. The reviewer adds the expectation when the question is answered, because `cmtk run` skips a case that has none.
- **A case that needs a body or an input file** gets its data from `/cmtk:data`, never from a value you make up: plan the case, name in `draft_note` which recipe should supply its body, and leave `request.body` out. `/cmtk:data` writes the rows and one draft case per row.
- **Data-changing requests** (POST, PUT, PATCH, DELETE) only run when a person turns on both switches: `allow_unsafe_methods: true` in the manifest, and `--allow-unsafe` on the run. Only do that against disposable test data. Draft such cases if the requirement needs them, and say in the plan that they need test data.
- **Runbook steps:** a step with an outcome that a request can check becomes a case. A step that needs a person, such as "confirm with the release manager", becomes a manual check.
- **OpenAPI input:** one case per documented operation and response, using the documented examples where there are any. Each documented error response gets an unhappy-path case.
- **Never** write secrets, tokens, real customer data or hosts into a case. Credentials come from `headers_from_env` at run time: name the variable in the plan, never its value.
- **Never touch accepted cases.** A case without `draft: true` has been accepted by a person. To change one, call `cmtk_propose` with kind `expectation`, the case id, the whole new `expect:` block and your reason. Never edit the file.
- **Don't re-propose rejected drafts.** `cmtk/rejected.yaml` holds what people rejected, with their reasons. Leave those cases out unless the requirement has changed.

## Steps

1. Read the inputs, the existing case files, `cmtk/rejected.yaml` if it exists, and `cmtk_proposals` with `status: all`. List the acceptance criteria in scope, with ids.
2. Write the plan and the draft cases. Check the existing case files so you never reuse an id.
3. Call `cmtk_check`. Fix anything it reports as invalid, and expect a warning for each case left without `expect:`.
4. Tell the person, briefly:
   - how many criteria are in scope;
   - how many cases you drafted;
   - how many manual checks;
   - the open questions.

   Then give them **only the review command** from `cmtk_commands_for_person`. Remind them that the drafts don't count until they accept them, and that a case they accept becomes the definition of correct.
