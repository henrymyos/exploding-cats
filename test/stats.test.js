'use strict';
// Family leaderboard: who counts, how wins/podiums add up, and the monthly table.
// Runs against a temp file; the Redis env vars are cleared so nothing real is touched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cats-stats-'));
process.env.STATS_FILE = path.join(dir, 'leaderboard.json');
for (const k of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k];
const stats = require('../server/stats');

const s = (id, name, place, isBot = false) => ({ id, name, place, isBot });

test('solo vs bots is not recorded', async () => {
  await stats.recordGame({ game: 'cats', standings: [s('a', 'Ann', 1), s('b', 'Bot', 2, true)], roomPlayers: [] });
  const lb = await stats.leaderboard();
  assert.equal(lb.players.length, 0);
  assert.equal(lb.recent.length, 0);
  assert.equal(lb.persistent, false);
});

test('a bot-driven seat is skipped even if standings say human', async () => {
  await stats.recordGame({
    game: 'cats',
    standings: [s('a', 'Ann', 1), s('b', 'Ben', 2)],
    roomPlayers: [{ id: 'b', isBot: true }],
  });
  assert.equal((await stats.leaderboard()).players.length, 0);
});

test('wins, podiums, per-game and monthly totals add up; names merge case-insensitively', async () => {
  await stats.recordGame({ game: 'cats', standings: [s('a', 'Ann', 1), s('b', 'Ben', 2), s('c', 'Cy', 4)], roomPlayers: [] });
  await stats.recordGame({ game: 'bluff', standings: [s('b', ' ben ', 1), s('a', 'ann', 2), s('x', 'Bot', 3, true)], roomPlayers: [] });
  await stats.recordGame({ game: 'cats', standings: [s('b', 'Ben', 1), s('c', 'Cy', 2)], roomPlayers: [] });

  const lb = await stats.leaderboard();
  const by = Object.fromEntries(lb.players.map((p) => [p.name.toLowerCase(), p]));
  assert.deepEqual(lb.players.map((p) => p.name), ['Ben', 'ann', 'Cy']); // sorted by wins, then win %
  assert.equal(by.ben.games, 3); assert.equal(by.ben.wins, 2); assert.equal(by.ben.winPct, 67);
  assert.deepEqual(by.ben.byGame, { cats: { games: 2, wins: 1 }, bluff: { games: 1, wins: 1 } });
  assert.equal(by.ann.podiums, 2);
  assert.equal(by.cy.podiums, 1); // 4th place is not a podium
  assert.equal(lb.month.players.reduce((n, p) => n + p.games, 0), 7);
  assert.equal(lb.recent[0].winner, 'Ben');
  assert.deepEqual(lb.recent[1].players, [' ben ', 'ann']); // bots never listed
  // Persisted to the temp file, not the real board.
  assert.equal(JSON.parse(fs.readFileSync(process.env.STATS_FILE, 'utf8')).history.length, 3);
});

test('history is capped at 100 games', async () => {
  for (let i = 0; i < 105; i++) {
    stats.recordGame({ game: 'strays', standings: [s('a', 'Ann', 1), s('b', 'Ben', 2)], roomPlayers: [] });
  }
  await stats.recordGame({ game: 'strays', standings: [s('a', 'Ann', 1), s('b', 'Ben', 2)], roomPlayers: [] });
  const data = JSON.parse(fs.readFileSync(process.env.STATS_FILE, 'utf8'));
  assert.equal(data.history.length, 100);
  assert.equal(data.players.ann.games, 108);
});
