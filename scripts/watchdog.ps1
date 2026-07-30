$ErrorActionPreference = "Stop"

$taskName = "La Cenaduria WhatsApp Bot"
$projectDirectory = Split-Path -Parent $PSScriptRoot
$disabledMarker = Join-Path $projectDirectory ".data\system-disabled"
$watchdogLog = Join-Path $projectDirectory "bot.watchdog.log"

if (Test-Path $disabledMarker) {
  exit 0
}

try {
  $response = Invoke-WebRequest `
    -UseBasicParsing `
    -Uri "http://127.0.0.1:3090/health" `
    -TimeoutSec 8
  if ($response.StatusCode -eq 200) {
    exit 0
  }
} catch {
  $healthError = $_.Exception.Message
}

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (!$task -or $task.State -eq "Disabled") {
  exit 0
}

$taskInfo = Get-ScheduledTaskInfo -TaskName $taskName
$startupAge = (Get-Date) - $taskInfo.LastRunTime
if ($task.State -eq "Running" -and $startupAge.TotalSeconds -lt 90) {
  exit 0
}

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content `
  -LiteralPath $watchdogLog `
  -Value "[$timestamp] Dashboard unavailable: $healthError. Restarting task."

if ($task.State -eq "Running") {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
}
Start-ScheduledTask -TaskName $taskName
