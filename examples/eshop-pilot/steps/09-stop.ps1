# Stop the IIS Express process that 02-start started, and nothing else.
. (Join-Path $PSScriptRoot 'lib.ps1')
$step = '09-stop'
Start-Step $step
$code = 0
$PidFile = Join-Path $Pilot 'scratch\iisexpress.pid'
try {
    if (Test-Path -LiteralPath $PidFile) {
        $id = [int](Get-Content -LiteralPath $PidFile -Raw)
        $p = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -eq 'iisexpress') { Stop-Process -Id $id; Write-Log "stopped IIS Express process $id" }
        else { Write-Log "process $id is not running IIS Express any more; nothing to stop" }
        Remove-Item -LiteralPath $PidFile
    } else { Write-Log 'no IIS Express process was started by the pilot' }
} catch {
    Write-Log "ERROR: $($_.Exception.Message)"
    $code = 1
}
End-Step $step $code
