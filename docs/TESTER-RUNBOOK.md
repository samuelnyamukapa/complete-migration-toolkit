# Tester runbook: from stories to a signed report

This runbook is for testing **one system against its requirements**. It works for any project; nothing here is about migrations. To compare an old system with a new one, see [RUNBOOK.md](RUNBOOK.md).

Each step says what to do and what you should see. You can do every step by hand with the `cmtk` command, or let an AI agent do the grind with the cmtk plugin's skills (see [plugin/README.md](../plugin/README.md)). Either way, **you decide**:
- an agent writes drafts and proposals, and nothing counts until you accept it, with `cmtk review`;
- a report is finished when you sign it, with `cmtk signoff`.

To practise first, use the bookshop example in [examples/bookshop](../examples/bookshop).

## Before you start

You need Node.js 22.5 or later. You also need the `cmtk` command, which you can get in either of two ways:
- with the plugin installed, it is in the plugin's `server` folder (ask the agent for the exact commands: it gets them from `cmtk_commands_for_person`);
- from a clone of the toolkit, run `npm install`, `npm run build`, then `npm link -w packages/cli`.

The commands below are written as `cmtk`.

## 1. Set up the project

Start the system you will test and note its address. Then, in the project folder:

```sh
cmtk init --candidate http://localhost:4100
```

- **You should see:** `Wrote cmtk.yaml, cmtk/cases/example.yaml.`
- **With an agent:** `/cmtk:test --url http://localhost:4100`.

## 2. Write the cases

One case or more for each acceptance criterion. Each case names its `requirement`, so the report shows every story's result. The format is in [MANIFEST.md](MANIFEST.md).

- **With an agent:** run `/cmtk:plan STORIES.md`. You get:
  - a plan in `cmtk/plans/`;
  - draft cases marked `draft: true`;
  - a list of questions wherever the stories are unclear.

  Answer the questions; that is where most bugs in requirements are found.
- **By hand:** write the case files in `cmtk/cases/`.

Then check them. This sends no requests:

```sh
cmtk check
```

- **You should see:** how many cases, how many requirements, and how many drafts and proposals wait for you.

## 3. Review the drafts

```sh
cmtk review
```

It asks for your name. Then, for each draft case and each proposal, it shows what it is and asks: accept, reject, skip or quit.

- **Accept** a case only if its expectation is what the requirement says. An accepted case becomes the definition of correct.
- **Reject** with a reason. Rejected drafts are kept in `cmtk/rejected.yaml`, so the same draft isn't proposed again.

Drafts never count in a run: they are reported as SKIPPED until you accept them.

## 4. Run

```sh
cmtk run
```

| You see | It means | Do this |
|---|---|---|
| PASS | Every accepted case passed | Go to step 6 |
| FAIL | At least one case failed | Step 5 |
| INCOMPLETE | Some cases were skipped or could not run | Read why in the report: drafts waiting for review, a request that changes data (it needs `allow_unsafe_methods: true` and `--allow-unsafe`), or a system that didn't answer |
| NO EVIDENCE | Nothing ran | The line under the verdict says why |

The report is `cmtk/evidence/run/REPORT.md`, with the results grouped by requirement.

## 5. Deal with failures

For each failure, decide: is the system wrong, or the case?

- **The system is wrong:** draft the defects with `cmtk defects run` (or `/cmtk:defects run`). Each draft in `cmtk/evidence/run/DEFECTS.md` has the steps, what was expected, what came back, and the evidence files. Check it, then file it in your tracker. The agent files one only after you say yes.
- **The case is wrong:** change it only with the person who owns the requirement. An agent can only propose a new expectation, which you accept or reject in `cmtk review`.

Run again after each fix.

## 6. Sign

```sh
cmtk signoff run
```

It shows the verdict and asks for your name, role and decision: accept, accept with conditions, or reject. The signature records a fingerprint of the evidence. If anything in the evidence folder changes, `cmtk status` says the signature no longer counts.

## Four ways of working

| Way | When | How |
|---|---|---|
| **Requirements** | Each sprint's stories | Steps 1 to 6, with `/cmtk:plan` on the sprint's stories |
| **Runbook** | Checking a written procedure, such as a release checklist | `/cmtk:plan RUNBOOK.md`: steps with a checkable outcome become cases, and steps that need a person stay in the plan as manual checks |
| **Explore** | Hunting for bugs no story covers | `/cmtk:explore "<charter>" --budget 50`, or `cmtk probe <target> "GET /path"` by hand. It only reads, stays within its budget and logs every request. Findings become draft cases for step 3 |
| **Regression** | Every pull request | Run the accepted cases in CI (below) |

## In CI

[examples/bookshop/ci/cmtk.yml](../examples/bookshop/ci/cmtk.yml) is a GitHub Actions workflow that:
1. starts the system;
2. runs `cmtk run --accepted-only`, which leaves out drafts nobody has reviewed yet;
3. keeps the report as a build artifact.

The exit code tells the pipeline the verdict:
- `0`: PASS;
- `1`: FAIL;
- `2`: INCOMPLETE or NO EVIDENCE;
- `3`: a settings problem.

Drafts never run in CI until a person accepts them; the report says how many were left out. Sign-off stays with a person, at a keyboard, after reading the report.

## When something goes wrong

| You see | Do this |
|---|---|
| `Review is for a person at a keyboard` | Run `cmtk review` yourself, in a terminal. Agents can't review |
| `a draft: a person accepts it with cmtk review` | That case is still a draft: step 3 |
| `ECONNREFUSED` | The system isn't running at the address in `cmtk.yaml` |
| `… requests in a row got no answer, so the run stopped early` | The system stopped answering. Check it is up and answers a request, then run again |
| `Another cmtk run is writing …` | A run is still going, perhaps one an agent started and stopped waiting for. Wait for it to finish |
| `Exploration only reads` | Exploration never changes data. Write a case for it instead, with test data |
