# Part 5 of the pilot: the rows `cmtk data` generated from the catalog-item schema, posted to legacy
# eShop's Create form as a browser would, each after reading the page for its anti-forgery token.
# Uses tester\cmtk-forms.yaml, whose evidence folder is its own, so cmtk\evidence stays signed.
#   -Valid   also runs the rows the schema calls valid, which RULE-009 says are saved (writes to
#            the scratch catalog); without it only the invalid rows run, which write nothing.
#   -SkipReview  does not start `cmtk review` first; drafts nobody has accepted are skipped by the run.
#   -Preflight   stops before the review: regenerates the rows, checks the settings, reads the Create
#                page and says whether the token field and the cookie are there. Sends no POST.
param([switch]$Valid, [switch]$SkipReview, [switch]$Preflight)
. (Join-Path $PSScriptRoot 'lib.ps1')
Start-Step '10-data-forms'
$cmtk = Join-Path $Pilot 'tools\cmtk\cmtk.mjs'
if (-not (Test-Path -LiteralPath $cmtk)) { $cmtk = Join-Path $Pilot 'tools\cmtk-0.2.0\cmtk.mjs' }
$manifest = Join-Path $Pilot 'tester\cmtk-forms.yaml'
$code = 0
try {
    $version = (& node $cmtk --version 2>&1 | Select-Object -Last 1)
    Write-Log "cmtk $version at $cmtk"
    if ([version]($version -replace '[^0-9.].*$', '') -lt [version]'0.5.1') { throw "cmtk $version is too old: `cmtk data cases --encoding form` needs 0.5.1. Copy the new cmtk.mjs to tools\cmtk\." }
    try { $r = Invoke-WebRequest -Uri 'http://localhost:53190/Catalog/Create' -UseBasicParsing -TimeoutSec 120; Write-Log "GET /Catalog/Create -> $($r.StatusCode), $($r.RawContentLength) bytes" }
    catch { throw "Legacy eShop is not answering on port 53190: run 06-start-legacy.cmd first. ($($_.Exception.Message))" }
    # What the cases rely on: the hidden token input and the anti-forgery cookie. Names only; never the values.
    $hasInput = $r.Content -match 'name="__RequestVerificationToken"'
    $attrs = @('path', 'expires', 'domain', 'max-age', 'samesite', 'secure', 'httponly')
    $cookies = (@($r.Headers['Set-Cookie']) -join ' ') -split '[,;]' | ForEach-Object { if ($_ -match '^\s*([^=\s]+)=') { $Matches[1] } } | Where-Object { $attrs -notcontains $_.ToLower() } | Select-Object -Unique
    Write-Log "Create page: token input $(if ($hasInput) { 'found' } else { 'NOT found' }); cookies set: $(if ($cookies) { $cookies -join ', ' } else { 'none' })"
    if (-not $hasInput) { throw 'The Create page has no input named __RequestVerificationToken, so the cases cannot take the token from it.' }
    # The rows are not kept in git: regenerate them from the recipe's seed, byte for byte.
    $code = Invoke-Logged 'cmtk data make catalog-item' { node $cmtk data make catalog-item --manifest $manifest --format json,csv }
    if ($code -ne 0) { throw "cmtk data make failed ($code)" }
    $code = Invoke-Logged 'cmtk check' { node $cmtk check --manifest $manifest }
    if ($Preflight) {
        Write-Log 'Preflight done: legacy answers, the token input is on the page, the rows regenerate and the settings check out. Nothing was posted.'
        End-Step '10-data-forms' $code
        exit $code
    }
    if (-not $SkipReview) {
        Write-Log '-- cmtk review (a person decides each draft; a = accept, r = reject, s = skip, q = stop)'
        & node $cmtk review --manifest $manifest
    }
    $only = @()
    if (-not $Valid) {
        # Only the invalid rows: their ids, from the invalid case file.
        $ids = Select-String -LiteralPath (Join-Path $Pilot 'tester\cmtk\cases-forms\data-catalog-item-invalid.yaml') -Pattern '^\s+- id: (\S+)' | ForEach-Object { $_.Matches[0].Groups[1].Value }
        $only = @('--only', ($ids -join ','))
        Write-Log "Running the $($ids.Count) invalid rows only (RULE-009: shown again, no write). Add -Valid for the rest."
    }
    $code = Invoke-Logged 'cmtk run --allow-unsafe' { node $cmtk run --manifest $manifest --allow-unsafe @only }
    $report = Join-Path $Pilot 'tester\cmtk\evidence-forms\run\REPORT.md'
    if (Test-Path -LiteralPath $report) {
        Write-Log "-- $report"
        Get-Content -LiteralPath $report -TotalCount 40 | ForEach-Object { Write-Log $_ }
    }
} catch {
    Write-Log "ERROR: $($_.Exception.Message)"
    $code = 1
}
End-Step '10-data-forms' $code
exit $code
