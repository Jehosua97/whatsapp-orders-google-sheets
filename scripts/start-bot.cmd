@echo off
setlocal

cd /d "%~dp0.."
set "NODE_EXE=C:\Program Files\nodejs\node.exe"

if not exist "%NODE_EXE%" (
  echo [%date% %time%] Node.js was not found at %NODE_EXE%.>> bot.stderr.log
  exit /b 1
)

echo [%date% %time%] Starting La Cenaduria bot.>> bot.stdout.log
"%NODE_EXE%" src\index.js >> bot.stdout.log 2>> bot.stderr.log
set "BOT_EXIT_CODE=%ERRORLEVEL%"
echo [%date% %time%] Bot stopped with exit code %BOT_EXIT_CODE%.>> bot.stderr.log

exit /b %BOT_EXIT_CODE%
