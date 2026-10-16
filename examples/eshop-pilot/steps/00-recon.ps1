. (Join-Path $PSScriptRoot 'lib.ps1')
$step = '00-recon'
Start-Step $step
$code = 0
try {
    Write-Log "PowerShell $($PSVersionTable.PSVersion); OS $([Environment]::OSVersion.VersionString); user temp $env:TEMP"
    foreach ($tool in 'node', 'npm', 'git', 'dotnet', 'pwsh') {
        $c = Get-Command $tool -ErrorAction SilentlyContinue
        Write-Log ("{0}: {1}" -f $tool, $(if ($c) { $c.Source } else { '(not found)' }))
    }
    if (Get-Command node -ErrorAction SilentlyContinue) { Invoke-Logged 'node --version' { node --version } | Out-Null }
    if (Get-Command npm -ErrorAction SilentlyContinue) { Invoke-Logged 'npm --version' { npm --version } | Out-Null }
    if (Get-Command git -ErrorAction SilentlyContinue) { Invoke-Logged 'git --version' { git --version } | Out-Null }
    if (Get-Command dotnet -ErrorAction SilentlyContinue) { Invoke-Logged 'dotnet --list-sdks' { dotnet --list-sdks } | Out-Null }
    foreach ($p in 'C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe',
                   'C:\Program Files\IIS Express\iisexpress.exe',
                   'C:\Program Files (x86)\IIS Express\iisexpress.exe',
                   'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
                   'C:\Program Files\Google\Chrome\Application\chrome.exe') {
        Write-Log ("{0}: {1}" -f $p, (Test-Path -LiteralPath $p))
    }
    $lp = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -ErrorAction SilentlyContinue).LongPathsEnabled
    Write-Log "LongPathsEnabled: $lp"
    foreach ($port in 53190, 53191, 5190) {
        $busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        Write-Log "port ${port}: $(if ($busy) { 'in use' } else { 'free' })"
    }
} catch {
    Write-Log "ERROR: $($_.Exception.Message)"
    $code = 1
}
End-Step $step $code
