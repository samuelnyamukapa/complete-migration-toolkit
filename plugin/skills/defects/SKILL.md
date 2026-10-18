---
name: defects
description: "Draft defects from the latest cmtk run or compare report: one per cause, with steps to reproduce, expected and actual results, and links to the evidence, credentials removed. Files them in a tracker only after a person approves each one. Usage: /cmtk:defects [run|compare] [--file]"
---

## Inputs

Arguments: `$ARGUMENTS`

If that line shows the literal text `$ARGUMENTS` or is empty, the skill was started from a plain-language request: take the options from the user's message.

- **`run` or `compare`**: which report to use. If not given, use the more recent of the two that has failures, and say which.
- **`--file`**: after drafting, offer to file the drafts in the project's tracker, one at a time, each only after the person says yes.

The **project** is the current working directory, with `cmtk.yaml` at its root. Pass `manifest` to the cmtk tools as the absolute path of `cmtk.yaml`.

**Tools.** `cmtk_defects` on the `cmtk` MCP server writes `DEFECTS.md` and `DEFECTS.json` in the report's evidence folder. To file a defect, use whatever tracker tool this session already has, such as GitHub's `gh issue create` or a Jira or Azure DevOps connector, and only with the person's yes for that defect.

## Rules

- **The drafts come from the tool.** Don't write a defect by hand from memory of the report, and never change what a draft says was expected or what came back.
- **You may improve a title** so that it says what is wrong, for whom, in under 80 characters. Show the person the new title next to the old one.
- **No secrets or personal data.** The tool removes the credentials it knows about. Before filing, read each draft once more for anything that looks like a token, a password, an email address or a customer's name. Remove it, and tell the person.
- **Nothing is filed without a person.** Show the exact title and body you will file, and wait for a yes for that defect. "File them all" from the person is fine, but only after they have seen the list of titles.
- **Link the evidence, don't copy it.** Give each evidence file's path in the project. Don't paste answer bodies into a tracker: they can hold data that shouldn't leave the team.
- **A defect against the system under test is not a test change.** If you come to think the *case* is wrong rather than the system, say so, and propose a new expectation with `cmtk_propose` (kind `expectation`) instead of filing.

## Steps

1. Call `cmtk_defects` with the mode. If nothing failed, say so and stop.
2. Read `DEFECTS.md`. For each draft, check the steps reproduce the failure as written, and suggest a better title if one would help.
3. Show the person a short list: id, title, cases and requirements.
4. With `--file`, or if the person asks, file the drafts one at a time, each after their yes. Write the tracker's id next to each draft in your reply. Never edit `DEFECTS.md` itself: it is rewritten from the report.
