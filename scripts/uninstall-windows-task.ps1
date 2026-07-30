$ErrorActionPreference = "Stop"

$taskName = "La Cenaduria WhatsApp Bot"
$watchdogTaskName = "La Cenaduria Bot Watchdog"

foreach ($name in @($taskName, $watchdogTaskName)) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Output "Scheduled task removed: $name"
  } else {
    Write-Output "Scheduled task not found: $name"
  }
}
