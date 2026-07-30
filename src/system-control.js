"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const WINDOWS_TASK_NAME = "La Cenaduria WhatsApp Bot";
const WINDOWS_WATCHDOG_TASK_NAME = "La Cenaduria Bot Watchdog";
const SYSTEM_DISABLED_MARKER = path.resolve(".data", "system-disabled");

async function disableScheduledBot() {
  fs.mkdirSync(path.dirname(SYSTEM_DISABLED_MARKER), { recursive: true });
  fs.writeFileSync(
    SYSTEM_DISABLED_MARKER,
    `${new Date().toISOString()}\n`,
  );

  const command = [
    `$names = @('${WINDOWS_TASK_NAME}', '${WINDOWS_WATCHDOG_TASK_NAME}')`,
    "foreach ($name in $names) {",
    "  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue",
    "  if ($task) { Disable-ScheduledTask -TaskName $name | Out-Null }",
    "}",
  ].join("; ");
  try {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
    ]);
  } catch (error) {
    fs.rmSync(SYSTEM_DISABLED_MARKER, { force: true });
    throw error;
  }
}

function requestGracefulShutdown(delayMs = 1000) {
  setTimeout(() => process.emit("SIGTERM"), delayMs);
}

module.exports = {
  disableScheduledBot,
  requestGracefulShutdown,
  SYSTEM_DISABLED_MARKER,
  WINDOWS_TASK_NAME,
  WINDOWS_WATCHDOG_TASK_NAME,
};
