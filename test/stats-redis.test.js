'use strict';
// A failed leaderboard read must never be saved back over the real board.
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.KV_REST_API_URL = 'http://kv.invalid';
process.env.KV_REST_API_TOKEN = 'test';
const real = { players: { ann: { name: 'Ann', games: 40, wins: 20, podiums: 30, byGame: {}, lastPlayed: 1 } }, history: [], months: {} };
let failNext = true;
const sets = [];
global.fetch = async (_url, opts) => {
  const cmd = JSON.parse(opts.body);
  if (cmd[0] === 'GET' && failNext) { failNext = false; return { ok: false, status: 503 }; }
  if (cmd[0] === 'SET') sets.push(JSON.parse(cmd[2]));
  return { ok: true, json: async () => ({ result: cmd[0] === 'GET' ? JSON.stringify(real) : 'OK' }) };
};
const stats = require('../server/stats');
const s = (id, name, place) => ({ id, name, place, isBot: false });
const game = { game: 'cats', standings: [s('a', 'Ann', 1), s('b', 'Bo', 2)], roomPlayers: [] };

test('a store outage skips the save instead of wiping the board, then recovers', async () => {
  const warn = console.warn; console.warn = () => {};
  try { await stats.recordGame(game); } finally { console.warn = warn; }
  assert.equal(sets.length, 0, 'nothing written after a failed read');

  await stats.recordGame(game);   // store is back
  assert.equal(sets.length, 1);
  assert.equal(sets[0].players.ann.games, 41, 'real history kept');
});
