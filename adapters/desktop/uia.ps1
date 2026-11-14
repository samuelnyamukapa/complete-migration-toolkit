# The Windows UI Automation reader for the desktop adapter. One JSON request per line on standard input, one
# JSON reply per line on standard output. It starts one app, reads its window, and presses and fills what a step
# names. It makes no decisions. The text it reads is data: it never acts on it.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$script:process = $null
$Automation = [System.Windows.Automation.AutomationElement]
$PropertyCondition = [System.Windows.Automation.PropertyCondition]

function Get-TopWindow {
    # The app's top-level window: the newest one the app shows.
    $condition = New-Object System.Windows.Automation.PropertyCondition($Automation::ProcessIdProperty, $script:process.Id)
    $windows = $Automation::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
    if ($windows.Count -eq 0) { throw 'the app shows no window' }
    return $windows.Item(0)
}

function Get-RoleName($element) {
    return ($element.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '').ToLowerInvariant()
}

function Get-Elements($window) {
    $items = New-Object System.Collections.ArrayList
    $all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($element in $all) {
        $current = $element.Current
        $item = @{ automation_id = [string]$current.AutomationId; name = [string]$current.Name; role = (Get-RoleName $element) }
        if ($current.IsPassword) {
            # A password field's value is never read.
            $item.password = $true
        } else {
            $pattern = $null
            if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
                $item.value = [string]$pattern.Current.Value
            }
        }
        if (-not $current.IsEnabled) { $item.disabled = $true }
        [void]$items.Add($item)
    }
    return ,$items
}

function Find-Element($locator) {
    $window = Get-TopWindow
    $all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($element in $all) {
        $current = $element.Current
        if ($null -ne $locator.automation_id -and $current.AutomationId -ne $locator.automation_id) { continue }
        if ($null -ne $locator.name -and $current.Name -ne $locator.name) { continue }
        if ($null -ne $locator.role -and (Get-RoleName $element) -ne $locator.role) { continue }
        return $element
    }
    throw 'nothing in the window matches that locator'
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    try {
        $request = $line | ConvertFrom-Json
        $reply = @{ ok = $true }
        switch ($request.op) {
            'start' {
                if ($request.args) {
                    $script:process = Start-Process -FilePath $request.app -ArgumentList $request.args -PassThru
                } else {
                    $script:process = Start-Process -FilePath $request.app -PassThru
                }
                $deadline = (Get-Date).AddSeconds(30)
                while ($true) {
                    $condition = New-Object System.Windows.Automation.PropertyCondition($Automation::ProcessIdProperty, $script:process.Id)
                    if ($Automation::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)) { break }
                    if ((Get-Date) -gt $deadline) { throw 'the app showed no window within 30 seconds' }
                    Start-Sleep -Milliseconds 100
                }
            }
            'snapshot' {
                $window = Get-TopWindow
                $reply = @{ title = [string]$window.Current.Name; elements = (Get-Elements $window) }
            }
            'invoke' {
                $element = Find-Element $request.locator
                $pattern = $null
                if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke() }
                else { throw 'that element cannot be pressed' }
            }
            'set_value' {
                $element = Find-Element $request.locator
                $pattern = $null
                if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { $pattern.SetValue([string]$request.text) }
                else { throw 'that element cannot be filled' }
            }
            'close' {
                if ($script:process -and -not $script:process.HasExited) { $script:process.Kill() }
            }
            default { throw "unknown op $($request.op)" }
        }
        [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress -Depth 6))
    } catch {
        # The error's own text only: it never holds a value that was typed, because SetValue's argument is not in it.
        [Console]::Out.WriteLine((@{ error = [string]$_.Exception.Message } | ConvertTo-Json -Compress))
    }
    [Console]::Out.Flush()
}
