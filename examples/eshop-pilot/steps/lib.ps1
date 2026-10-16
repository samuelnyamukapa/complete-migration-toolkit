# Shared helpers for the pilot steps. Each step writes logs\<step>.log and logs\<step>.exit.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Pilot = Split-Path -Parent $PSScriptRoot
$Logs = Join-Path $Pilot 'logs'
New-Item -ItemType Directory -Force -Path $Logs | Out-Null
$script:LogFile = $null
function Start-Step([string]$Name) {
    $script:LogFile = Join-Path $Logs "$Name.log"
    Remove-Item -LiteralPath $script:LogFile, (Join-Path $Logs "$Name.exit") -ErrorAction SilentlyContinue
    Write-Log "== $Name  $(Get-Date -Format o)"
}
function Write-Log([string]$Text) {
    Write-Host $Text
    Add-Content -LiteralPath $script:LogFile -Value $Text -Encoding UTF8
}
# Run a native command, show and log its output, and return its exit code.
function Invoke-Logged([string]$Label, [scriptblock]$Command) {
    Write-Log "-- $Label"
    $global:LASTEXITCODE = 0
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { & $Command 2>&1 | ForEach-Object { Write-Log ([string]$_) } }
    finally { $ErrorActionPreference = $prev }
    $code = $global:LASTEXITCODE
    Write-Log "-- exit $code"
    return $code
}
function End-Step([string]$Name, [int]$Code) {
    Write-Log "== end ${Name}: exit $Code"
    Set-Content -LiteralPath (Join-Path $Logs "$Name.exit") -Value $Code -Encoding ASCII
}
