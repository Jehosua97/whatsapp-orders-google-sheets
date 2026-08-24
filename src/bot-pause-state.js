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
    return Boolean(this.state[String(chatId || "")]?.pausedAt);
  }

  pause(chatId, now = new Date()) {
    this.state[String(chatId)] = {
      ...(this.state[String(chatId)] || {}),
      pausedAt: now.toISOString(),
    };
    this.persist();
  }

  resume(chatId) {
    const key = String(chatId);
    if (!this.state[key]) return;
    delete this.state[key].pausedAt;
    if (!this.state[key].lastMessage) delete this.state[key];
    this.persist();
  }

  rememberLastMessage(chatId, message) {
    const text = String(message || "").trim();
    if (!text) return;
    const key = String(chatId);
    this.state[key] = {
      ...(this.state[key] || {}),
      lastMessage: text,
    };
    this.persist();
  }

  lastMessage(chatId) {
    return String(this.state[String(chatId)]?.lastMessage || "");
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporaryFile = `${this.file}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(this.state, null, 2));
    fs.renameSync(temporaryFile, this.file);
  }
}

module.exports = { BotPauseState, botControlCommand };
