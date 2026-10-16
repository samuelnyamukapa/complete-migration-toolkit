# The final runs: cmtk run on legacy (stories and reviewed HAR cases) and cmtk compare against
# CatalogCore. Then stop the IIS Express process the pilot started.
. (Join-Path $PSScriptRoot 'lib.ps1')
$step = '04-final'
Start-Step $step
$code = 0
$Shim = Join-Path $Pilot 'cmtk.cmd'
try {
    Set-Location -LiteralPath $Pilot
    Invoke-Logged 'cmtk run' { & $Shim run } | Out-Null
    Invoke-Logged 'cmtk compare' { & $Shim compare --manifest compare-catalogcore.yaml } | Out-Null
    Invoke-Logged 'cmtk status' { & $Shim status } | Out-Null
    Invoke-Logged 'cmtk status (compare)' { & $Shim status --manifest compare-catalogcore.yaml } | Out-Null
} catch {
    Write-Log "ERROR: $($_.Exception.Message)"
    $code = 1
} finally {
    & (Join-Path $PSScriptRoot '09-stop.ps1')
}
End-Step $step $code
