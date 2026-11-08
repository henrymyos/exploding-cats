'use strict';
// A throw inside a timer callback (bot move, pending-window resolve) must not
// crash the process: timers run outside any try/catch, so it would be uncaught.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RoomManager } = require('../server/rooms');

function startedRoom() {
  const mgr = new RoomManager(() => {});
  const room = mgr.createRoom('Host', 'h1', null, 'original');
  mgr.addBot(room.code, 'h1');
  mgr.startGame(room.code, 'h1');
  clearTimeout(room.botTimer);
  clearTimeout(room.timer);
  return { mgr, room };
}

test('a throwing bot job is logged, not thrown', (t) => {
  const err = t.mock.method(console, 'error', () => {});
  const { mgr, room } = startedRoom();
  room.game.playerById = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => mgr.runBotJob(room, 'turn', 'h1'));
  assert.equal(err.mock.callCount(), 1);
});

test('a throwing resolve timer is logged and the process stays up', async (t) => {
  const err = t.mock.method(console, 'error', () => {});
  const { mgr, room } = startedRoom();
  room.game.pending = { kind: 'action', endsAt: Date.now() };
  room.game.resolveAction = () => { throw new Error('boom'); };
  mgr.scheduleResolve(room);
  await new Promise((r) => setTimeout(r, 100)); // an uncaught throw here fails the run
  assert.equal(err.mock.callCount(), 1);
  clearTimeout(room.botTimer);
});
