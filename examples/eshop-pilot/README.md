# eShop pilot for the Complete Migration Toolkit

> This is the folder used for the first pilot, on 16 October 2026, kept as a worked example.
> What it found is written up in [docs/pilots/eshop.md](../../docs/pilots/eshop.md), and the final
> reports are in `reports/`. To run it yourself you need the eShop sandbox at
> `D:\githubProjects\modernize-sandbox` (change `$Sandbox` in `steps\01-setup.ps1` for another
> place), Visual Studio 2022 with IIS Express, the .NET 8 SDK and Node.js 22.5 or later.

This folder tests the eShop sandbox with `cmtk` without changing it. The sandbox
(`D:\githubProjects\modernize-sandbox`) is only ever read: its sources are copied into `scratch\`,
and every build and host runs from there. `checksums\` holds a fingerprint of every sandbox file
taken before the pilot, to show afterwards that nothing changed.

## The two systems

| | What | How it runs | Address |
|---|---|---|---|
| Legacy | eShop, ASP.NET MVC 5 on .NET Framework 4.7.2, mock data | a scratch copy built by VS MSBuild, hosted by IIS Express | http://localhost:53190 |
| CatalogCore | the catalog service rebuilt for .NET 8 by the modernize plugin | a class library: no web host yet | none: reached through `adapters\catalog` |

## Steps

Double-click these in order. Each writes `logs\<step>.log`.

1. `00-recon.cmd`: lists the tools on this machine.
2. `01-setup.cmd`: installs cmtk in `tools\`, copies legacy eShop and CatalogCore into `scratch\`,
   switches the scratch copy to mock data, and builds legacy.
3. `02-start.cmd`: starts legacy on port 53190, builds the catalog probe for both systems, then runs
   `cmtk run` (legacy against the stories) and `cmtk compare` (legacy against CatalogCore).
4. `03-checks.cmd`: plants a defect in the scratch CatalogCore and shows `cmtk compare` catches it,
   records a HAR of real use in Edge and imports it, and runs the Windows checks (paths with spaces
   and over 260 characters, `$env:` credentials, sign-off refusing piped input, the MCP server).
5. `04-final.cmd`: the final `cmtk run` and `cmtk compare`, then stops legacy.
6. `05-review-plan.cmd`: the AI tester's part (added 19 October 2026). `/cmtk:plan` drafted a test plan
   and 39 draft cases from the eShop business rules. This step checks them and starts `cmtk review`,
   where a person accepts or rejects each draft. Read `tester\cmtk\plans\catalog.md` first.
7. `06-start-legacy.cmd`: starts legacy on port 53190 and nothing else, for the AI tester. Use it instead
   of `02-start.cmd`, which also reruns `cmtk run` and `cmtk compare` and so replaces the signed reports.
   IIS Express keeps its logs in `scratch\iisexpress-home`, not Documents: with them in Documents
   (synced by OneDrive) legacy stopped answering after its first request.
8. `07-ping-legacy.cmd`: checks that legacy answers, and writes `logs\07-ping-legacy.log`.
9. `09-stop.cmd`: stops legacy, if it is still running.

To run cmtk by hand from this folder:

```powershell
.\cmtk.cmd run                                        # legacy against the stories
.\cmtk.cmd compare --manifest compare-catalogcore.yaml   # legacy against CatalogCore
.\cmtk.cmd status
```

## Files

| Path | What |
|---|---|
| `cmtk.yaml`, `cmtk\cases\legacy\` | `cmtk run`: legacy eShop over HTTP, one case per acceptance criterion |
| `compare-catalogcore.yaml`, `cmtk\cases\catalogcore\` | `cmtk compare`: the catalog service on both builds |
| `adapters\catalog\` | the adapter and the probe it runs: one C# source built for net472 (legacy) and net8.0 (CatalogCore) |
| `cmtk\drift*.yaml` | approved drift; only a named person adds an entry |
| `cmtk\evidence*\` | answers and reports from each run |
| `compare-canary.yaml` | the same comparison with a planted defect, to prove it is caught |
| `cmtk\cases\imported\har.yaml` | the raw HAR import, before review; the reviewed cases are `cmtk\cases\legacy\har-journeys.yaml` |
| `reports\` | the final reports from the pilot, and the log of the Windows checks |
| `tester\` | the AI tester's plan (`cmtk\plans\catalog.md`), its draft cases and their source rules; `tester\cmtk.yaml` tests legacy on its own |
| `scratch\`, `tools\`, `logs\` | working copies, cmtk itself and step logs; never evidence |
