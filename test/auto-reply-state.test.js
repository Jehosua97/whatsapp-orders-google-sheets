"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const {
  AutoReplyState,
  isAllowedChat,
} = require("../src/auto-reply-state");

test("evita repetir el saludo dentro del periodo configurado", () => {
  const file = path.join(
    os.tmpdir(),
    `lacenaduria-auto-reply-${process.pid}-${Date.now()}.json`,
  );
  const state = new AutoReplyState(file, 24);

  assert.equal(state.shouldSend("test@lid", 1000), true);
  state.markSent("test@lid", 1000);
  assert.equal(state.shouldSend("test@lid", 2000), false);
  assert.equal(state.shouldSend("test@lid", 1000 + 25 * 60 * 60 * 1000), true);
});

test("solo permite chats incluidos de forma exacta", () => {
  const allowlist = new Set(["test@lid"]);
  assert.equal(isAllowedChat("test@lid", allowlist), true);
  assert.equal(isAllowedChat("cliente-real@lid", allowlist), false);
  assert.equal(isAllowedChat("test@c.us", allowlist), false);
});
