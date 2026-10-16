# 1. Update cmtk. 2. Canary: plant a defect in the scratch CatalogCore, show compare catches it, restore.
# 3. Record a HAR of real use of legacy in Edge and import it. 4. Windows checks for issue #7.
. (Join-Path $PSScriptRoot 'lib.ps1')
$step = '03-checks'
Start-Step $step
$code = 0
$Npm = 'C:\Program Files\nodejs\npm.cmd'
$Cmtk = Join-Path $Pilot 'tools\complete-migration-toolkit'
$Shim = Join-Path $Pilot 'cmtk.cmd'
$Probe = Join-Path $Pilot 'adapters\catalog\probe\CatalogProbe.csproj'
try {
    if ((Invoke-Logged 'git pull' { git -c core.fscache=false -c core.preloadindex=false -C $Cmtk pull --ff-only }) -ne 0) { throw 'git pull failed' }
    Invoke-Logged 'cmtk commit' { git -C $Cmtk log --oneline -1 } | Out-Null
    Push-Location -LiteralPath $Cmtk
    try { if ((Invoke-Logged 'npm run build' { & $Npm run build }) -ne 0) { throw 'build failed' } } finally { Pop-Location }
    Set-Location -LiteralPath $Pilot

    # 2. Canary
    $vm = Join-Path $Pilot 'scratch\catalogcore\CatalogCore\ViewModel\PaginatedItemsViewModel.cs'
    $original = [IO.File]::ReadAllText($vm)
    try {
        [IO.File]::WriteAllText($vm, $original.Replace('Math.Ceiling', 'Math.Floor'))
        Write-Log 'canary: scratch CatalogCore now rounds the page count down (Math.Floor)'
        if ((Invoke-Logged 'build probe with the canary' { dotnet build $Probe -c Release -f net8.0 --nologo -v quiet }) -ne 0) { throw 'canary build failed' }
        $c = Invoke-Logged 'cmtk compare (canary, must be NO PARITY)' { & $Shim compare --manifest compare-canary.yaml }
        Write-Log "canary compare exit $c (1 means the planted defect was caught)"
    } finally {
        [IO.File]::WriteAllText($vm, $original)
        Write-Log 'canary removed: scratch CatalogCore restored'
        Invoke-Logged 'rebuild probe without the canary' { dotnet build $Probe -c Release -f net8.0 --nologo -v quiet } | Out-Null
    }
    Invoke-Logged 'cmtk compare (restored, must be PARITY)' { & $Shim compare --manifest compare-catalogcore.yaml } | Out-Null

    # 3. HAR: record real use in Edge, import it, keep it out of evidence
    $har = Join-Path $Pilot 'tools\har'
    if (!(Test-Path -LiteralPath (Join-Path $har 'node_modules\playwright-core'))) {
        Set-Content -LiteralPath (Join-Path $har 'package.json') -Value '{ "private": true }' -Encoding ASCII
        if ((Invoke-Logged 'npm install playwright-core' { & $Npm install --prefix $har playwright-core@1.48.2 --no-audit --no-fund }) -ne 0) { throw 'playwright-core install failed' }
    }
    if ((Invoke-Logged 'record HAR in Edge' { node (Join-Path $PSScriptRoot 'record-har.mjs') }) -ne 0) { throw 'HAR recording failed' }
    Remove-Item -LiteralPath (Join-Path $Pilot 'cmtk\cases\imported\har.yaml') -ErrorAction SilentlyContinue
    Invoke-Logged 'cmtk import-har' { & $Shim import-har recording.har --out cmtk/cases/imported/har.yaml } | Out-Null

    # 4. Windows checks (#7)
    Invoke-Logged 'MCP server from a Windows client' { node (Join-Path $PSScriptRoot 'mcp-check.mjs') } | Out-Null
    Remove-Item -LiteralPath (Join-Path $Pilot 'recording.har') -ErrorAction SilentlyContinue
    Write-Log 'raw HAR deleted (it may hold secrets and is not evidence)'

    $rb = Join-Path $Pilot 'runbook check'
    if (Test-Path -LiteralPath $rb) { Remove-Item -LiteralPath $rb -Recurse -Force }
    New-Item -ItemType Directory -Path $rb | Out-Null
    Push-Location -LiteralPath $rb
    try {
        Invoke-Logged 'init in a folder with a space' { & $Shim init --candidate http://localhost:53190 } | Out-Null
        Invoke-Logged 'run with a relative --manifest' { & $Shim run --manifest .\cmtk.yaml } | Out-Null
        $env:CMTK_PILOT_TOKEN = 'Bearer pilot-check-7f3a'
        $long = 'cmtk/' + ((1..10 | ForEach-Object { 'evidence-segment-' + $_.ToString('000') }) -join '/')
        $yaml = [IO.File]::ReadAllText((Join-Path $rb 'cmtk.yaml')).Replace('headers_from_env: {}', 'headers_from_env: { X-Pilot-Check: CMTK_PILOT_TOKEN }').Replace('evidence: cmtk/evidence', "evidence: $long")
        [IO.File]::WriteAllText((Join-Path $rb 'long.yaml'), $yaml)
        Invoke-Logged 'run with a $env: header and evidence past 260 characters' { & $Shim run --manifest long.yaml } | Out-Null
        Invoke-Logged 'scan for long paths and the secret' { node (Join-Path $PSScriptRoot 'scan.mjs') $rb 'pilot-check-7f3a' } | Out-Null
        Remove-Item Env:\CMTK_PILOT_TOKEN
        $s = Invoke-Logged 'signoff with piped input must refuse' { 'Robot' | & $Shim signoff run }
        Write-Log "signoff exit $s (3 means refused)"
    } finally { Pop-Location }
} catch {
    Write-Log "ERROR: $($_.Exception.Message)"
    $code = 1
}
End-Step $step $code
