$ErrorActionPreference = "Stop"

$taskName = "La Cenaduria WhatsApp Bot"
$projectDirectory = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot "start-bot.cmd"
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction `
  -Execute "$env:SystemRoot\System32\cmd.exe" `
  -Argument "/d /s /c `"`"$launcher`"`"" `
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

Write-Output "Scheduled task installed: $taskName"
Write-Output "The bot will start automatically when $userId signs in."
