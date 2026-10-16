# Start legacy (scratch copy, IIS Express, port 53190), build the catalog probe for both systems,
# then run `cmtk run` and `cmtk compare`. Nothing here writes to the sandbox.
. (Join-Path $PSScriptRoot 'lib.ps1')
$step = '02-start'
Start-Step $step
$code = 0
$Npm = 'C:\Program Files\nodejs\npm.cmd'
$Cmtk = Join-Path $Pilot 'tools\complete-migration-toolkit'
$Web = Join-Path $Pilot 'scratch\legacy\src\eShopLegacyMVC'
$PidFile = Join-Path $Pilot 'scratch\iisexpress.pid'
$Url = 'http://localhost:53190/'
$Shim = Join-Path $Pilot 'cmtk.cmd'
try {
    # 1. The latest cmtk
    # Git on this machine sometimes cannot write loose objects (see the sandbox PLAYBOOK); these
    # settings worked there. If the pull still fails, move the old copy aside and clone afresh.
    if ((Invoke-Logged 'git pull' { git -c core.fscache=false -c core.preloadindex=false -C $Cmtk pull --ff-only }) -ne 0) {
        $old = Join-Path $Pilot ("tools\old-" + (Get-Date -Format yyyyMMddHHmmss))
        Rename-Item -LiteralPath $Cmtk -NewName (Split-Path -Leaf $old)
        Write-Log "moved the old copy to $old"
        if ((Invoke-Logged 'git clone' { git clone https://github.com/samuelnyamukapa/complete-migration-toolkit $Cmtk }) -ne 0) { throw 'git clone failed' }
    }
    Invoke-Logged 'cmtk commit' { git -C $Cmtk log --oneline -1 } | Out-Null
    Push-Location -LiteralPath $Cmtk
    try {
        if ((Invoke-Logged 'npm ci' { & $Npm ci --no-audit --no-fund }) -ne 0) { throw 'npm ci failed' }
        if ((Invoke-Logged 'npm run build' { & $Npm run build }) -ne 0) { throw 'build failed' }
    } finally { Pop-Location }

    # 2. Legacy on IIS Express
    $listening = Get-NetTCPConnection -LocalPort 53190 -State Listen -ErrorAction SilentlyContinue
    if (!$listening) {
        $p = Start-Process -FilePath 'C:\Program Files\IIS Express\iisexpress.exe' -ArgumentList "/path:`"$Web`" /port:53190 /systray:false /clr:v4.0" -WindowStyle Minimized -PassThru
        Set-Content -LiteralPath $PidFile -Value $p.Id -Encoding ASCII
        Write-Log "IIS Express started, process $($p.Id)"
    } else { Write-Log 'port 53190 is already listening; using it' }
    $ok = $false
    for ($i = 0; $i -lt 36 -and !$ok; $i++) {
        try {
            $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 60
            Write-Log "GET / -> $($r.StatusCode)"
            $ok = $r.StatusCode -eq 200
        } catch { Write-Log "waiting for legacy: $($_.Exception.Message)"; Start-Sleep -Seconds 5 }
    }
    if (!$ok) { throw 'legacy did not answer 200 on /' }

    # 3. The catalog probe, built for net472 (legacy assembly) and net8.0 (CatalogCore)
    $proj = Join-Path $Pilot 'adapters\catalog\probe\CatalogProbe.csproj'
    if ((Invoke-Logged 'dotnet build probe' { dotnet build $proj -c Release --nologo -v minimal }) -ne 0) { throw 'probe build failed' }
    foreach ($tfm in 'net472', 'net8.0') {
        $exe = Join-Path $Pilot "adapters\catalog\probe\bin\Release\$tfm\CatalogProbe.exe"
        Invoke-Logged "probe $tfm /brands" { '/brands' | & $exe } | Out-Null
    }

    # 4. cmtk
    Push-Location -LiteralPath $Pilot
    try {
        $run = Invoke-Logged 'cmtk run' { & $Shim run }
        $cmp = Invoke-Logged 'cmtk compare' { & $Shim compare --manifest compare-catalogcore.yaml }
        Invoke-Logged 'cmtk status' { & $Shim status } | Out-Null
        Invoke-Logged 'cmtk status (compare manifest)' { & $Shim status --manifest compare-catalogcore.yaml } | Out-Null
        Write-Log "cmtk run exit $run; cmtk compare exit $cmp"
    } finally { Pop-Location }
} catch {
    Write-Log "ERROR: $($_.Exception.Message)"
    $code = 1
}
End-Step $step $code
