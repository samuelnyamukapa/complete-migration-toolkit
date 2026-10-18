---
name: plan
description: "Turn user stories, acceptance criteria, a runbook, a requirements document or an OpenAPI file into a written test plan and draft cmtk case files, for a person to review. Every case traces to a requirement; anything unclear becomes a question, not a guess. Usage: /cmtk:plan <files or folder> [--topic <name>]"
---

## Inputs

Arguments: `$ARGUMENTS`

If that line shows the literal text `$ARGUMENTS` or is empty, the skill was started from a plain-language request: take the input files and the topic from the user's message. If no input is named, ask which files hold the requirements. Never invent requirements.

- **Input files**, inside the project: stories with acceptance criteria, a runbook, a requirements document, or an OpenAPI (Swagger) JSON file. Read every one before you write anything.
- **`--topic <name>`**, optional: a short name for this plan, such as `catalog`. It names the files you write. Letters, digits and `-` only. If not given, choose one from the input and say which.

The **project** is the current working directory, with `cmtk.yaml` at its root (use `/cmtk:test` first if there is none). Pass `manifest` to the cmtk tools as the absolute path of `cmtk.yaml`.

**Tools.** `cmtk_check` and `cmtk_proposals` on the `cmtk` MCP server, and your own file tools to write the plan and the case files. If the `cmtk` server is not available, stop and say so.

## What you write

1. **The test plan, `cmtk/plans/<topic>.md`.** It is written for a tester to read in five minutes, and holds:
   - a table with one row per acceptance criterion: the requirement id, what must be true, the case ids that check it, and whether it can be automated or must be checked by hand;
   - for each case: the steps, the data, and the expected result in plain words;
   - a "Questions" section: everything the requirements leave unclear.
2. **Draft cases, `cmtk/cases/<topic>.yaml`.** The format is in the toolkit's `docs/MANIFEST.md`. Every case you write has:
   - `id`: unique, letters, digits, `.`, `-` and `_`, such as `CAT-1-03`. Check the existing case files first, so you never reuse an id;
   - `name`: what it checks, in words;
   - `requirement`: the story and criterion, such as `CAT-1/AC-2`, exactly as the input names it. If the input has no ids, make simple ones (`REQ-1/AC-1`) and list them in the plan;
   - `request`: `GET /path` or `{ method, path, headers, body }`. A path, never a host;
   - `expect`: only what the requirement states;
   - `draft: true`;
   - `draft_note`: one or two lines: which sentence of the input this comes from, and any doubt.

## Rules

- **Expectations come from the requirement, never from the running system.** Do not call the system to see what it answers and then expect that: it would turn today's bugs into the definition of correct. For a migration, expecting the legacy system's behaviour is right when the requirement is "behave like the old system". Then `cmtk compare` checks it, and the cases need no `expect:`.
- **One case or more per acceptance criterion**, including the unhappy paths the criterion implies: an unknown id, a missing field, an empty list, a value at and past each limit.
- **Unclear means a question, not a guess.** If a criterion doesn't say what the answer should be (which status? which message? which order?), write the question in the plan's Questions section. Then either leave `expect:` out of that case or expect only what is certain, and say so in `draft_note`.
- **Data-changing requests** (POST, PUT, PATCH, DELETE) only run against disposable test data, and only when a person turns on both switches. Write such cases if the requirement needs them, and say in the plan that they need test data.
- **Runbook steps:** a step with an outcome a request can check becomes a case. A step that needs a person, such as "confirm with the release manager", goes in the plan as a manual check.
- **OpenAPI input:** one case per documented operation and response, using the documented examples where there are any. Each documented error response gets an unhappy-path case.
- **Never** write secrets, tokens, real customer data or hosts into a case. Credentials come from `headers_from_env` at run time: name the variable in the plan, never its value.
- **Never touch accepted cases.** A case without `draft: true` has been accepted by a person. If you think one is wrong or missing something, call `cmtk_propose` with kind `expectation`, the case id, the whole new `expect:` block and your reason. Don't edit the file.
- **Don't re-propose rejected drafts.** Check `cmtk/rejected.yaml` first and leave out anything a person already rejected, unless the requirement has changed.

## Steps

1. Read the inputs, the existing case files and `cmtk/rejected.yaml`. List the acceptance criteria you found, with ids.
2. Write the plan and the draft cases.
3. Call `cmtk_check`. Fix anything it reports as invalid in your drafts, and look at its warnings.
4. Tell the person, briefly:
   - how many criteria you found;
   - how many cases you drafted;
   - how many questions are open, and the questions themselves.

   Then give them the review command from `cmtk_commands_for_person`. Remind them that the drafts don't count until they accept them, and that a case they accept becomes the definition of correct.
