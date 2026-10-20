# Start legacy eShop (the scratch copy, on IIS Express, port 53190) and nothing else. No build and
# no cmtk run, so the signed evidence from the first pilot stays as it is. Used by the AI tester
# (tester\) through 06-start-legacy.cmd. Stop it with 09-stop.cmd.
. (Join-Path $PSScriptRoot 'lib.ps1')
$step = '06-start-legacy'
Start-Step $step
$code = 0
$Web = Join-Path $Pilot 'scratch\legacy\src\eShopLegacyMVC'
$PidFile = Join-Path $Pilot 'scratch\iisexpress.pid'
$Url = 'http://localhost:53190/'
try {
    if (!(Test-Path -LiteralPath (Join-Path $Web 'bin\eShopLegacyMVC.dll'))) { throw "legacy is not built in ${Web}: run 01-setup.cmd first" }
    $listening = Get-NetTCPConnection -LocalPort 53190 -State Listen -ErrorAction SilentlyContinue
    if (!$listening) {
        # IIS Express keeps its logs and settings under scratch\, not in Documents: on this machine,
        # with them in Documents (synced by OneDrive), legacy stopped answering after its first request.
        $env:IIS_USER_HOME = Join-Path $Pilot 'scratch\iisexpress-home'
        New-Item -ItemType Directory -Force -Path $env:IIS_USER_HOME | Out-Null
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
    # A second request: once, legacy answered the first request and then nothing more.
    try { $r2 = Invoke-WebRequest -Uri ($Url + 'Catalog/Details/1') -UseBasicParsing -TimeoutSec 20; Write-Log "GET /Catalog/Details/1 -> $($r2.StatusCode)" }
    catch { throw "legacy answered / but not a second request: $($_.Exception.Message)" }
    Write-Log "legacy eShop is running at $Url"
} catch {
    Write-Log "ERROR: $($_.Exception.Message)"
    $code = 1
}
End-Step $step $code
