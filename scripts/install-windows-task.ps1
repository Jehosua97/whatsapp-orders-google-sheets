$ErrorActionPreference = "Stop"

$taskName = "La Cenaduria WhatsApp Bot"
$watchdogTaskName = "La Cenaduria Bot Watchdog"
$projectDirectory = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot "start-bot-hidden.vbs"
$watchdog = Join-Path $PSScriptRoot "watchdog-hidden.vbs"
$disabledMarker = Join-Path $projectDirectory ".data\system-disabled"
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction `
  -Execute "$env:SystemRoot\System32\wscript.exe" `
  -Argument "`"$launcher`"" `
  -WorkingDirectory $projectDirectory
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal `
  -UserId $userId `
  -LogonType Interactive `
  -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable

$task = New-ScheduledTask `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings

Register-ScheduledTask `
  -TaskName $taskName `
  -InputObject $task `
  -Force | Out-Null

if (Test-Path $disabledMarker) {
  Remove-Item -LiteralPath $disabledMarker -Force
}

$watchdogAction = New-ScheduledTaskAction `
  -Execute "$env:SystemRoot\System32\wscript.exe" `
  -Argument "`"$watchdog`"" `
  -WorkingDirectory $projectDirectory
$watchdogTrigger = New-ScheduledTaskTrigger `
  -Once `
  -At ((Get-Date).AddMinutes(1)) `
  -RepetitionInterval (New-TimeSpan -Minutes 1)
$watchdogSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable
$watchdogTask = New-ScheduledTask `
  -Action $watchdogAction `
  -Trigger $watchdogTrigger `
  -Principal $principal `
  -Settings $watchdogSettings

Register-ScheduledTask `
  -TaskName $watchdogTaskName `
  -InputObject $watchdogTask `
  -Force | Out-Null

Write-Output "Scheduled task installed: $taskName"
Write-Output "Watchdog installed: $watchdogTaskName"
Write-Output "The bot will start automatically when $userId signs in."
