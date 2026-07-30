$ErrorActionPreference = "Stop"

$taskName = "La Cenaduria WhatsApp Bot"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

if (!$task) {
  & "$PSScriptRoot\install-windows-task.ps1"
} else {
  Enable-ScheduledTask -TaskName $taskName | Out-Null
}

Start-ScheduledTask -TaskName $taskName
Write-Output "System enabled: $taskName"
