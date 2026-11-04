# A nightly comparison

Copy one of these into your own project. Neither has run on a real schedule yet: a test checks that the commands they use exist, and that a series of runs gives the trend report it should.

Both do the same three things:

1. Run `cmtk compare --dated`, and keep its exit code.
2. Run `cmtk trend`, even when the comparison found differences.
3. End with the comparison's exit code, so a bad night shows as a failed run.

## GitHub Actions

Copy [github-nightly.yml](github-nightly.yml) to `.github/workflows/nightly.yml` in your project. Set the `CMTK_TOKEN` secret if your systems need a login, and add `headers_from_env: { Authorization: CMTK_TOKEN }` to `cmtk.yaml`.

GitHub's runners start empty, so the workflow restores the dated runs from the Actions cache. A cache can be evicted. If the history must last, keep it somewhere of your own.

Your systems must be reachable from the runner. For a system inside your network, use a self-hosted runner.

## Windows scheduled task

Copy [nightly.ps1](nightly.ps1) into your project, next to `cmtk.yaml`. Then, once, as the person who owns the task:

```powershell
schtasks /Create /TN "cmtk nightly" /SC DAILY /ST 02:17 /TR "powershell -NoProfile -File C:\path\to\project\nightly.ps1"
```

Set any token the task needs as an environment variable for that user. Never write it in the script.

## Exit codes

| Code | Means | What the examples do |
|---|---|---|
| 0 | PARITY or DRIFT ONLY | Pass |
| 1 | NO PARITY | Fail, and the trend report is still written |
| 2 | INCOMPLETE or NO EVIDENCE | Fail, and the trend report is still written |
| 3 | A settings problem | Fail |
| 4 | PARTIAL COMPARISON | Fail. If your project accepts it, say so in the script and name who agreed |

## Each morning

Read `cmtk/evidence/trend/compare/TREND.md`. Start with what is new, then what keeps coming back and what is flaky. Only a person decides whether a difference is noise, drift or a defect.
