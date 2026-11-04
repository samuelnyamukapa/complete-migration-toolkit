# eShop pilot, cmtk 0.6: the browser journey, and what UI Automation sees on the desktop sample. npm on this machine is broken, so node runs Playwright's installer itself.
$ErrorActionPreference = 'Continue'
$Pilot = Split-Path $PSScriptRoot -Parent
Set-Location $Pilot
$cmtk = Join-Path $Pilot 'tools\cmtk-0.6\cmtk.mjs'
$sum = Join-Path $Pilot 'logs\11b-verify-summary.txt'
$log = Join-Path $Pilot 'logs\11b-verify.log'
"browser and desktop, $(Get-Date -Format s)" | Set-Content $sum
"" | Set-Content $log
function Step($name, $expected, [string[]]$a) {
    "== $name" | Add-Content $log
    $out = & cmd /c "node `"$cmtk`" $($a -join ' ') 2>&1"
    $code = $LASTEXITCODE
    $out | Add-Content $log
    $v = ($out | Select-String -Pattern 'verdict|Cases:|passes' | Select-Object -First 2 | ForEach-Object { $_.Line }) -join ' | '
    "$name | exit $code | expected $expected | $v" | Add-Content $sum
}
Step 'web adapter kit' 0 @('adapter','check','web','--manifest','cmtk-web-06.yaml')
Step 'catalog journey in a browser' 0 @('run','--manifest','cmtk-web-06.yaml')
try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, UIAutomationClientsideProviders
    [System.Windows.Automation.ClientSettings]::RegisterClientSideProviderAssembly([UIAutomationClientsideProviders.UIAutomationClientSideProviders].Assembly.GetName())
    "desktop: client-side providers registered" | Add-Content $sum
    $app = Start-Process powershell -PassThru -WindowStyle Minimized -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-STA','-File',(Join-Path $Pilot 'adapters\desktop\samples\SampleApp.ps1')
    Start-Sleep -Seconds 8
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Orders')
    $w = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
    if ($w) {
        "desktop: window found, class '$($w.Current.ClassName)' process $($w.Current.ProcessId), app $($app.Id)" | Add-Content $sum
        foreach ($e in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
            $c = $e.Current
            "desktop: id='$($c.AutomationId)' name='$($c.Name)' class='$($c.ClassName)' type='$($c.ControlType.ProgrammaticName)'" | Add-Content $sum
        }
    } else { "desktop: no window called Orders" | Add-Content $sum }
    Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
} catch { "desktop: $($_.Exception.Message)" | Add-Content $sum }
