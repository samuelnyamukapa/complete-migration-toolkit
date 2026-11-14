# Trends: comparing over days and weeks

One clean run can hide differences that come and go. Run the comparison on a schedule, keep each run, and read the trend.

## Keep each run

```sh
cmtk compare --dated
```

The latest run still goes in `cmtk/evidence/compare/`, where `cmtk status` and `cmtk signoff` read it. `--dated` also copies it to `cmtk/evidence/history/compare/2026-11-04T02-17-00Z/`. The time in the name is UTC. `--dated` works the same way on `cmtk run` and `cmtk shadow`.

To keep every run without the flag, put this in `cmtk.yaml`:

```yaml
evidence_history:
  dated: true
  keep_days: 30    # default 90
  keep_runs: 60    # default: no limit, per mode
  max_mb: 500      # default 1024
```

## Read the trend

```sh
cmtk trend                    # the mode with the newest dated run
cmtk trend --mode compare --last 14
```

It reads the dated reports and writes `cmtk/evidence/trend/compare/TREND.md` and `TREND.json`. It sends nothing and changes no report. The exit code is 0 with a report, and 2 when there are no dated runs yet. It says nothing about parity on its own: use each run's own exit code for that.

| Section | What it shows |
|---|---|
| Verdict over time | Each run's verdict and counts, and any run whose settings file changed, because a verdict can change when a scrub or a drift entry does |
| Differences by where | Each `where`, with list positions as `[*]`. For `cmtk run`, each failed check. **new:** only in the latest run. **keeps coming back:** in the latest run and an earlier one. **gone:** the latest run checked it and it did not show. **not checked:** the latest run did not reach those cases, so nothing is claimed |
| Flaky cases | A case whose result changed at least twice. A case that changed once and stayed changed is listed as started failing or started passing instead, because one change is not flaky |
| Drift that stopped matching | An entry that matched in an earlier run and matches nothing now. Entries that never matched are listed apart |
| Scrubs that never fired | A rule in the latest settings that changed nothing in any run. It may be mistyped, or no longer needed. Reports made before this version do not record it |

A report that cannot be read is named and not counted. For `cmtk shadow`, each endpoint counts as a case.

Only a person decides what any of this means. A trend report is not signed, and it changes no ledger.

## Clean-up

Every dated run applies the rule, in this order:

1. Remove dated runs older than `keep_days`.
2. Remove the oldest beyond `keep_runs` per mode.
3. Remove the oldest until the history fits `max_mb`.

Two things are always kept: the newest run of each mode, and a run with a `SIGNOFF.json` in it. If what is left is still over the limit, you get a warning. The latest run in `cmtk/evidence/<mode>/` is not part of the history, and clean-up never touches it.

To clean by hand, or to see what would go first:

```sh
cmtk trend clean --keep-days 14 --dry-run
cmtk trend clean --max-mb 200
```

**Clean-up never follows a link.** It removes only real folders with a dated name under `history/<mode>/`. A link at any level is left alone or removed as a link, and what it points to is never touched. A `history` folder that is itself a link leading out of the project is refused.

## A nightly run

[examples/nightly](../examples/nightly/README.md) has a GitHub Actions workflow and a Windows scheduled task.

Evidence can hold what your systems answered. Keep it where your project's other test data is kept.
