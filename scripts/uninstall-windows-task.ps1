$ErrorActionPreference = "Stop"

$taskName = "La Cenaduria WhatsApp Bot"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

if ($task) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Output "Scheduled task removed: $taskName"
} else {
  Write-Output "Scheduled task not found: $taskName"
}
