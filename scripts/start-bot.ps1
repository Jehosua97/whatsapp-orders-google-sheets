$ErrorActionPreference = "Continue"

$projectDirectory = Split-Path -Parent $PSScriptRoot
$nodeExecutable = "C:\Program Files\nodejs\node.exe"
$disabledMarker = Join-Path $projectDirectory ".data\system-disabled"
$standardOutputLog = Join-Path $projectDirectory "bot.stdout.log"
$standardErrorLog = Join-Path $projectDirectory "bot.stderr.log"
$mutex = [System.Threading.Mutex]::new(
  $false,
  "Local\LaCenaduriaWhatsAppBotLauncher"
)
$ownsMutex = $false

try {
  try {
    $ownsMutex = $mutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $ownsMutex = $true
  }

  if (!$ownsMutex) {
    exit 0
  }

  Set-Location -LiteralPath $projectDirectory
  if (!(Test-Path -LiteralPath $nodeExecutable)) {
    Add-Content -LiteralPath $standardErrorLog -Value "[$(Get-Date -Format s)] Node.js was not found at $nodeExecutable."
    exit 1
  }

  if (!(Test-Path -LiteralPath $disabledMarker)) {
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:3090/health" -TimeoutSec 3
      if ($health.status -eq "ok") {
        exit 0
      }
    } catch {}
  }

  while (!(Test-Path -LiteralPath $disabledMarker)) {
    Add-Content -LiteralPath $standardOutputLog -Value "[$(Get-Date -Format s)] Starting La Cenaduria bot."
    & $nodeExecutable "src\index.js" 1>> $standardOutputLog 2>> $standardErrorLog
    $botExitCode = $LASTEXITCODE
    Add-Content -LiteralPath $standardErrorLog -Value "[$(Get-Date -Format s)] Bot stopped with exit code $botExitCode."
    if (Test-Path -LiteralPath $disabledMarker) { break }
    Add-Content -LiteralPath $standardOutputLog -Value "[$(Get-Date -Format s)] Restarting bot in 10 seconds."
    Start-Sleep -Seconds 10
  }

  exit 0
} finally {
  if ($ownsMutex) {
    $mutex.ReleaseMutex()
  }
  $mutex.Dispose()
}
