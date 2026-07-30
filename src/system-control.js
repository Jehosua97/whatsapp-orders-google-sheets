"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const WINDOWS_TASK_NAME = "La Cenaduria WhatsApp Bot";

async function disableScheduledBot() {
  const command =
    `Disable-ScheduledTask -TaskName '${WINDOWS_TASK_NAME}' ` +
    "-ErrorAction Stop | Out-Null";
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command,
  ]);
}

function requestGracefulShutdown(delayMs = 1000) {
  setTimeout(() => process.emit("SIGTERM"), delayMs);
}

module.exports = {
  disableScheduledBot,
  requestGracefulShutdown,
  WINDOWS_TASK_NAME,
};
