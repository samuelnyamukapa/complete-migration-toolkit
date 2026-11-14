# eShop pilot, cmtk 0.6: everything that needs no person. Each result goes to logs\11-verify-summary.txt.
$ErrorActionPreference = 'Continue'
$Pilot = Split-Path $PSScriptRoot -Parent
Set-Location $Pilot
$cmtk = Join-Path $Pilot 'tools\cmtk-0.6\cmtk.mjs'
$sum = Join-Path $Pilot 'logs\11-verify-summary.txt'
$log = Join-Path $Pilot 'logs\11-verify.log'
"cmtk 0.6 on eShop, $(Get-Date -Format s)" | Set-Content $sum
"" | Set-Content $log
function Step($name, $expected, [string[]]$a) {
    Write-Host "== $name"
    "== $name" | Add-Content $log
    $out = & cmd /c "node `"$cmtk`" $($a -join ' ') 2>&1"
    $code = $LASTEXITCODE
    $out | Add-Content $log
    $verdict = ($out | Select-String -Pattern 'verdict|Verdict|parity|PARITY|Cases:|passes' | Select-Object -First 2 | ForEach-Object { $_.Line }) -join ' | '
    "$name | exit $code | expected $expected | $verdict" | Add-Content $sum
    Write-Host "   exit $code (expected $expected)"
}
try { $r = Invoke-WebRequest -Uri 'http://localhost:53190/' -UseBasicParsing -TimeoutSec 120; "legacy answers $($r.StatusCode)" | Add-Content $sum }
catch { "legacy is NOT answering on 53190: start 06b-start-legacy-console.cmd" | Add-Content $sum; Write-Host 'Legacy is not answering. Start 06b-start-legacy-console.cmd first.'; exit 1 }
Step 'signatures still hold (run)' 0 @('status')
Step 'signatures still hold (compare)' 0 @('status','--manifest','compare-catalogcore.yaml')
Step 'run on legacy' '1, 40 of 41' @('run','--manifest','cmtk-06.yaml')
Step 'compare with CatalogCore' '0, PARITY 24 of 24' @('compare','--manifest','compare-catalogcore-06.yaml')
Step 'canary' '0, PARITY: the planted defect was removed from the source after 16 October' @('compare','--manifest','compare-canary-06.yaml')
Step 'one manifest, run' '1, HTTP cases only' @('run','--manifest','cmtk-one-manifest.yaml')
Step 'one manifest, compare' '4, PARTIAL COMPARISON' @('compare','--manifest','cmtk-one-manifest.yaml')
Step 'discover' 0 @('discover','--manifest','cmtk-06.yaml','--config','scratch\legacy\src\eShopLegacyMVC\Web.config','--fresh')
# The browser adapter
Push-Location (Join-Path $Pilot 'adapters\web')
if (-not (Test-Path 'node_modules\playwright')) { & cmd /c 'npm install --no-audit --no-fund 2>&1' | Add-Content $log; & cmd /c 'npx playwright install chromium 2>&1' | Add-Content $log }
Pop-Location
Step 'web adapter kit' 0 @('adapter','check','web','--manifest','cmtk-web-06.yaml')
Step 'catalog journey in a browser' 0 @('run','--manifest','cmtk-web-06.yaml')
# Desktop: why UI Automation could not find the control on a CI machine. Only the sample app is touched.
try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $app = Start-Process powershell -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-STA','-File',(Join-Path $Pilot 'adapters\desktop\samples\SampleApp.ps1')
    Start-Sleep -Seconds 6
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Orders')
    $w = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
    if ($w) {
        "desktop: window found" | Add-Content $sum
        foreach ($e in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
            $c = $e.Current
            "desktop: id='$($c.AutomationId)' name='$($c.Name)' class='$($c.ClassName)' type='$($c.ControlType.ProgrammaticName)'" | Add-Content $sum
        }
    } else { "desktop: no window called Orders" | Add-Content $sum }
    Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
} catch { "desktop: $($_.Exception.Message)" | Add-Content $sum }
