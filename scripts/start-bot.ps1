$ErrorActionPreference = "Continue"

$projectDirectory = Split-Path -Parent $PSScriptRoot
$nodeExecutable = "C:\Program Files\nodejs\node.exe"
$stdoutLog = Join-Path $projectDirectory "bot.stdout.log"
$stderrLog = Join-Path $projectDirectory "bot.stderr.log"
$disabledMarker = Join-Path $projectDirectory ".data\system-disabled"
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
    Add-Content -LiteralPath $stdoutLog -Value (
      "[{0}] Bot launcher already active; duplicate stopped." -f `
        (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    )
    exit 0
  }

  Set-Location -LiteralPath $projectDirectory
  if (!(Test-Path -LiteralPath $nodeExecutable)) {
    Add-Content -LiteralPath $stderrLog -Value (
      "[{0}] Node.js was not found at {1}." -f `
        (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $nodeExecutable
    )
    exit 1
  }

  while (!(Test-Path -LiteralPath $disabledMarker)) {
    Add-Content -LiteralPath $stdoutLog -Value (
      "[{0}] Starting La Cenaduria bot." -f `
        (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    )
    & $nodeExecutable "src\index.js" 1>> $stdoutLog 2>> $stderrLog
    $exitCode = $LASTEXITCODE
    Add-Content -LiteralPath $stderrLog -Value (
      "[{0}] Bot stopped with exit code {1}." -f `
        (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $exitCode
    )

    if (Test-Path -LiteralPath $disabledMarker) {
      break
    }
    Add-Content -LiteralPath $stdoutLog -Value (
      "[{0}] Restarting bot in 10 seconds." -f `
        (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    )
    Start-Sleep -Seconds 10
  }
} finally {
  if ($ownsMutex) {
    $mutex.ReleaseMutex()
  }
  $mutex.Dispose()
}
