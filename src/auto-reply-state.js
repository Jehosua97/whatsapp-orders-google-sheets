"use strict";

const fs = require("node:fs");
const path = require("node:path");

function isAllowedChat(chatId, allowlist) {
  return allowlist instanceof Set && allowlist.has(chatId);
}

class AutoReplyState {
  constructor(file, cooldownHours) {
    this.file = file;
    this.cooldownMs = cooldownHours * 60 * 60 * 1000;
    this.state = this.load();
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  shouldSend(chatId, now = Date.now()) {
    const lastSent = Number(this.state[chatId] || 0);
    return !lastSent || now - lastSent >= this.cooldownMs;
  }

  markSent(chatId, now = Date.now()) {
    this.state[chatId] = now;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }
}

module.exports = { AutoReplyState, isAllowedChat };
