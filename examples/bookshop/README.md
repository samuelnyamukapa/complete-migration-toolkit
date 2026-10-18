# Bookshop: try the AI tester

A tiny bookshop API, with **bugs on purpose**, for trying the cmtk skills in ten minutes. Version 2 is a "rewrite", so you can also try comparing two systems.

| File | What |
|---|---|
| `server.mjs` | The bookshop: `node server.mjs` (version 1, port 4100), `node server.mjs --v2` (version 2, port 4101). No dependencies |
| `STORIES.md` | The requirements: what the bookshop must do |
| `RUNBOOK-release.md` | A release checklist, to try planning from a runbook |
| `CHANGES-v2.md` | What version 2 changes on purpose |
| `cmtk.yaml` | Test version 1 against the stories |
| `compare.yaml` | Compare version 2 with version 1 |
| `cmtk/cases/health.yaml` | The one case the example starts with |
| `ci/cmtk.yml` | A GitHub Actions workflow that runs the accepted cases on every pull request |

## Try it

You need Node.js 22.5 or later, and the cmtk plugin in GitHub Copilot or Claude Code (see `plugin/README.md`).

1. In a terminal, in this folder: `node server.mjs`
2. Start Copilot or Claude Code in this folder and ask: *"/cmtk:plan STORIES.md --topic shop"*. You get a test plan in `cmtk/plans/shop.md`, draft cases in `cmtk/cases/shop.yaml`, and questions where the stories are unclear.
3. Run the review command the agent gives you. Read each draft: accept it if it matches the story, and reject it if it doesn't.
4. Ask: *"run the cases"*. Several fail, because the bookshop has bugs.
5. Ask: *"/cmtk:defects run"* for drafted defects.
6. Ask: *"/cmtk:explore \"try to break paging with odd page numbers and sizes\" --budget 30"*. It finds more, and each finding is a draft case for you to review.

**To compare two systems:** also start `node server.mjs --v2` in another terminal. Then ask *"/cmtk:triage --run"* (it uses `compare.yaml`; tell it so). It should sort the differences into:
- noise: a timestamp and a request id;
- intended drift: the new `currency` field, documented in `CHANGES-v2.md`;
- defects: anything else.

You decide each one with `cmtk review`.

## Without an AI agent

The same steps work by hand with the `cmtk` command: `cmtk check`, `cmtk run`, `cmtk probe candidate "GET /api/books?page=-1"`, `cmtk defects run`, `cmtk review` and `cmtk signoff run`. The tester runbook, [docs/TESTER-RUNBOOK.md](../../docs/TESTER-RUNBOOK.md), walks through them.

## Spoilers

The planted problems are listed in `SPOILERS.md`. Read it after you have tried.
