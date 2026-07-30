"use strict";

const fs = require("node:fs");
const path = require("node:path");

function botControlCommand(value) {
  const command = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
  if (command === "STOP BOT") return "STOP";
  if (command === "CONTINUE BOT") return "CONTINUE";
  return "";
}

class BotPauseState {
  constructor(file) {
    this.file = file;
    this.state = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  isPaused(chatId) {
    return Boolean(this.state[String(chatId || "")]);
  }

  pause(chatId, now = new Date()) {
    this.state[String(chatId)] = {
      pausedAt: now.toISOString(),
    };
    this.persist();
  }

  resume(chatId) {
    delete this.state[String(chatId)];
    this.persist();
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporaryFile = `${this.file}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(this.state, null, 2));
    fs.renameSync(temporaryFile, this.file);
  }
}

module.exports = { BotPauseState, botControlCommand };
