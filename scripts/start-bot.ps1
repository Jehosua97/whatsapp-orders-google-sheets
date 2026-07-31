$ErrorActionPreference = "Continue"

$projectDirectory = Split-Path -Parent $PSScriptRoot
$batchLauncher = Join-Path $PSScriptRoot "start-bot.cmd"
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
  if (!(Test-Path -LiteralPath $batchLauncher)) {
    exit 1
  }
  & $env:ComSpec /d /s /c $batchLauncher
  exit $LASTEXITCODE
} finally {
  if ($ownsMutex) {
    $mutex.ReleaseMutex()
  }
  $mutex.Dispose()
}
