"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  BotPauseState,
  botControlCommand,
} = require("../src/bot-pause-state");

test("reconoce solamente los comandos manuales del bot", () => {
  assert.equal(botControlCommand("STOP BOT"), "STOP");
  assert.equal(botControlCommand("  stop   bot "), "STOP");
  assert.equal(botControlCommand("continue bot"), "CONTINUE");
  assert.equal(botControlCommand("stop"), "");
  assert.equal(botControlCommand("cliente: STOP BOT por favor"), "");
});

test("conserva las conversaciones pausadas despues de reiniciar", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "lacenaduria-pauses-"),
  );
  const file = path.join(directory, "pauses.json");
  const state = new BotPauseState(file);

  state.pause("customer@lid", new Date("2026-07-30T12:00:00.000Z"));
  assert.equal(state.isPaused("customer@lid"), true);
  assert.equal(new BotPauseState(file).isPaused("customer@lid"), true);

  state.resume("customer@lid");
  assert.equal(state.isPaused("customer@lid"), false);
  assert.equal(new BotPauseState(file).isPaused("customer@lid"), false);
});
