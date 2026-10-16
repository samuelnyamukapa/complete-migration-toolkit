# Install cmtk 0.1.1 in tools\, and build scratch copies of legacy eShop and CatalogCore in scratch\.
# The sandbox is only ever read: robocopy copies from it, and every build runs in scratch\.
. (Join-Path $PSScriptRoot 'lib.ps1')
$step = '01-setup'
Start-Step $step
$code = 0
$Sandbox = 'D:\githubProjects\modernize-sandbox'
$Npm = 'C:\Program Files\nodejs\npm.cmd'
$MSBuild = 'C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe'
$Tools = Join-Path $Pilot 'tools'
$Cmtk = Join-Path $Tools 'complete-migration-toolkit'
$Scratch = Join-Path $Pilot 'scratch'
try {
    # 1. cmtk
    New-Item -ItemType Directory -Force -Path $Tools | Out-Null
    if (!(Test-Path -LiteralPath $Cmtk)) {
        if ((Invoke-Logged 'git clone' { git clone https://github.com/samuelnyamukapa/complete-migration-toolkit $Cmtk }) -ne 0) { throw 'git clone failed' }
    } else {
        if ((Invoke-Logged 'git pull' { git -C $Cmtk pull --ff-only }) -ne 0) { throw 'git pull failed' }
    }
    Invoke-Logged 'cmtk commit' { git -C $Cmtk log --oneline -1 } | Out-Null
    Push-Location -LiteralPath $Cmtk
    try {
        if ((Invoke-Logged 'npm ci' { & $Npm ci --no-audit --no-fund }) -ne 0) { throw 'npm ci failed' }
        if ((Invoke-Logged 'npm run build' { & $Npm run build }) -ne 0) { throw 'build failed' }
    } finally { Pop-Location }
    $shim = "@echo off`r`nnode `"%~dp0tools\complete-migration-toolkit\packages\cli\dist\main.js`" %*`r`n"
    [IO.File]::WriteAllText((Join-Path $Pilot 'cmtk.cmd'), $shim, [Text.Encoding]::ASCII)
    Invoke-Logged 'cmtk --version' { & (Join-Path $Pilot 'cmtk.cmd') --version } | Out-Null

    # 2. Scratch copies (robocopy codes below 8 mean success)
    New-Item -ItemType Directory -Force -Path $Scratch | Out-Null
    $legacy = Join-Path $Scratch 'legacy'
    $r = Invoke-Logged 'copy legacy source' { robocopy (Join-Path $Sandbox 'sources\eShopLegacyMVCSolution') $legacy /E /XD .git bin obj packages /R:0 /W:0 /NFL /NDL /NP }
    if ($r -ge 8) { throw "robocopy legacy failed: $r" }
    $core = Join-Path $Scratch 'catalogcore\CatalogCore'
    $r = Invoke-Logged 'copy CatalogCore source' { robocopy (Join-Path $Sandbox 'modernized\eshop\CatalogCore\src\main\CatalogCore') $core /E /XD .git bin obj /R:0 /W:0 /NFL /NDL /NP }
    if ($r -ge 8) { throw "robocopy CatalogCore failed: $r" }
    $global:LASTEXITCODE = 0

    # 3. Mock data in the scratch copy only, so no database is needed
    $webConfig = Join-Path $legacy 'src\eShopLegacyMVC\Web.config'
    $text = [IO.File]::ReadAllText($webConfig)
    $new = $text.Replace('<add key="UseMockData" value="false" />', '<add key="UseMockData" value="true" />')
    if ($new -eq $text) { throw 'UseMockData setting not found in the scratch Web.config' }
    [IO.File]::WriteAllText($webConfig, $new, (New-Object Text.UTF8Encoding($true)))
    Write-Log 'scratch Web.config: UseMockData=true'

    # 4. Build legacy with VS MSBuild (the mixed packages.config graph needs it)
    $proj = Join-Path $legacy 'src\eShopLegacyMVC\eShopLegacyMVC.csproj'
    $buildLog = Join-Path $Logs 'legacy-build.log'
    $b = Invoke-Logged 'MSBuild legacy (scratch)' { & $MSBuild $proj /restore /p:RestorePackagesConfig=true /p:Configuration=Debug /verbosity:minimal /nologo "/flp:logfile=$buildLog;encoding=UTF-8;verbosity=normal" }
    if ($b -ne 0) { throw "legacy build failed: $b" }
    Write-Log ("legacy assembly: {0}" -f (Test-Path -LiteralPath (Join-Path $legacy 'src\eShopLegacyMVC\bin\eShopLegacyMVC.dll')))
} catch {
    Write-Log "ERROR: $($_.Exception.Message)"
    $code = 1
}
End-Step $step $code
