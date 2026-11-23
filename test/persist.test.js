'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Enable persistence against a stubbed store before persist.js reads its env.
process.env.KV_REST_API_URL = 'http://kv.invalid';
process.env.KV_REST_API_TOKEN = 'test';
const writes = [];
global.fetch = async (_url, opts) => {
  writes.push(JSON.parse(opts.body));
  return { ok: true, json: async () => ({ result: 'OK' }) };
};
const persist = require('../server/persist');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const room = { code: 'ABCD', hostId: 'p1', players: [{ id: 'p1', name: 'Ann', connected: true }], game: null };

test('unchanged rooms are not re-saved; a real change is', async () => {
  const rooms = new Map([['ABCD', room]]);
  persist.scheduleSave(rooms);
  await wait(500);
  persist.scheduleSave(rooms); // same state, e.g. a broadcast that changed nothing persisted
  await wait(500);
  assert.equal(writes.length, 1);
  const saved = JSON.parse(writes[0][2]);
  assert.equal(saved[0].code, 'ABCD');
  assert.ok(saved[0].savedAt > 0, 'savedAt still stamped for the 12h expiry');

  room.players[0].connected = false;
  persist.scheduleSave(rooms);
  await wait(500);
  assert.equal(writes.length, 2);
});
