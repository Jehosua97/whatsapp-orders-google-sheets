$ErrorActionPreference = "Stop"

$taskName = "La Cenaduria WhatsApp Bot"
$watchdogTaskName = "La Cenaduria Bot Watchdog"
$projectDirectory = Split-Path -Parent $PSScriptRoot
$disabledMarker = Join-Path $projectDirectory ".data\system-disabled"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$watchdogTask = Get-ScheduledTask `
  -TaskName $watchdogTaskName `
  -ErrorAction SilentlyContinue

if (!$task -or !$watchdogTask) {
  & "$PSScriptRoot\install-windows-task.ps1"
} else {
  Enable-ScheduledTask -TaskName $taskName | Out-Null
  Enable-ScheduledTask -TaskName $watchdogTaskName | Out-Null
  if (Test-Path $disabledMarker) {
    Remove-Item -LiteralPath $disabledMarker -Force
  }
}

Start-ScheduledTask -TaskName $taskName
Write-Output "System enabled: $taskName"
