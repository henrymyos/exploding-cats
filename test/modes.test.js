'use strict';
// Headless checks for the two other game modes: Cat Bluff (dice) and Stray Cats (hidden roles).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BluffGame, START_DICE } = require('../server/bluff');
const bluffBrain = require('../server/bluffBrain');
const { StraysGame } = require('../server/strays');
const straysBrain = require('../server/straysBrain');

const seats = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, isBot: true }));

// ---------- Cat Bluff ----------

test('bluff: 1s are wild except on a bid of 1s; a bid must raise qty or face', () => {
  const g = new BluffGame(seats(2));
  g.players[0].dice = [1, 1, 3, 4, 5];
  g.players[1].dice = [3, 3, 6, 6, 2];
  assert.equal(g.countFace(3), 5);   // three 3s + two wild 1s
  assert.equal(g.countFace(1), 2);   // no wilds on 1s
  assert.ok(g.bidBeats(1, 2, null));
  assert.ok(g.bidBeats(3, 2, { qty: 2, face: 6 }));
  assert.ok(g.bidBeats(2, 5, { qty: 2, face: 4 }));
  assert.ok(!g.bidBeats(2, 4, { qty: 2, face: 4 }));
  assert.ok(!g.bidBeats(1, 6, { qty: 2, face: 2 }));
});

test('bluff: a call costs the wrong player exactly one die', () => {
  const g = new BluffGame(seats(2));
  g.players[0].dice = [2, 2, 2, 2, 2];
  g.players[1].dice = [5, 5, 5, 5, 5];
  g.turnIndex = 0;
  assert.ok(g.placeBid('p0', 6, 2).ok);           // only five 2s: a bluff
  assert.ok(g.callBluff('p1').ok);
  assert.equal(g.reveal.loserId, 'p0');
  assert.equal(g.players[0].dice.length, START_DICE - 1);
  assert.equal(g.players[1].dice.length, START_DICE);
  assert.ok(!g.placeBid('p0', 1, 2).ok, 'no moves during the reveal');
});

// Same loop rooms.js runs: bot bids or calls, a refused bid falls back to a call, the timer ends reveals.
function playBluff(g, maxSteps = 5000) {
  for (let step = 0; step < maxSteps; step += 1) {
    if (g.phase === 'finished') return step;
    if (g.pending) {
      const before = g.totalDice();
      g.finishReveal();
      assert.ok(g.totalDice() <= before);
      continue;
    }
    const cur = g.currentPlayer();
    assert.ok(cur && cur.alive, 'current player is alive');
    const before = g.totalDice();
    const mv = bluffBrain.chooseMove(g, cur);
    if (mv.kind === 'call' || !g.placeBid(cur.id, mv.qty, mv.face).ok) {
      assert.ok(g.callBluff(cur.id).ok, 'a refused bid can always be called');
      assert.equal(g.totalDice(), before - 1, 'a call removes one die');
    }
  }
  return -1;
}

test('bluff: bot games finish with one living winner and a full recap', () => {
  for (const n of [2, 4, 10]) {
    for (let r = 0; r < 5; r += 1) {
      const g = new BluffGame(seats(n));
      assert.notEqual(playBluff(g), -1, `${n}p did not finish`);
      const alive = g.alivePlayers();
      assert.equal(alive.length, 1, `${n}p exactly one survivor`);
      assert.equal(g.winnerId, alive[0].id);
      assert.equal(g.deadOrder.length, n - 1);
      const places = g.buildRecap().standings.map((s) => s.place);
      assert.deepEqual(places, Array.from({ length: n }, (_, i) => i + 1));
      assert.equal(g.buildRecap().standings[0].id, g.winnerId);
    }
  }
});

test('bluff: snapshots hide other players\' dice until the reveal', () => {
  const g = new BluffGame(seats(3));
  const snap = g.snapshotFor('p0');
  assert.deepEqual(snap.myDice, g.players[0].dice);
  assert.ok(snap.players.find((p) => p.id === 'p1').dice === null);
});

// ---------- Stray Cats ----------

test('strays: roles are 1 Stray below 8 players, 2 from 8, and always one Vet', () => {
  for (const n of [4, 7, 8, 10]) {
    const g = new StraysGame(seats(n));
    const roles = g.players.map((p) => p.role);
    assert.equal(roles.filter((x) => x === 'stray').length, n >= 8 ? 2 : 1, `${n}p strays`);
    assert.equal(roles.filter((x) => x === 'vet').length, 1, `${n}p vet`);
  }
});

test('strays: the first night is quiet and a tied or skip-majority vote sends nobody out', () => {
  const g = new StraysGame(seats(4));
  const stray = g.players.find((p) => p.role === 'stray');
  const house = g.players.find((p) => p.role === 'house');
  assert.ok(!g.pick(stray.id, house.id).ok, 'no chase on night 1');
  g.onTimer();                       // night ends
  assert.equal(g.alivePlayers().length, 4);
  g.onTimer();                       // reveal -> day
  assert.equal(g.stage, 'day');
  const [a, b, c, d] = g.players.map((p) => p.id);
  g.vote(a, b); g.vote(b, a); g.vote(c, null); g.vote(d, null);
  assert.equal(g.stage, 'reveal');
  assert.equal(g.reveal.outId, null);
  assert.equal(g.alivePlayers().length, 4);
});

function checkStraysEnd(g, label) {
  assert.equal(g.phase, 'finished', `${label} finished`);
  const strays = g.aliveStrays().length;
  const house = g.aliveHouse().length;
  if (g.winnerTeam === 'house') assert.equal(strays, 0, `${label} house won with no strays left`);
  else {
    assert.equal(g.winnerTeam, 'strays', label);
    assert.ok(strays >= house, `${label} strays won with a majority`);
  }
  const winner = g.playerById(g.winnerId);
  assert.ok(winner && (g.winnerTeam === 'strays') === (winner.role === 'stray'), `${label} winner is on the winning team`);
  for (const s of g.buildRecap().standings) {
    const p = g.playerById(s.id);
    assert.equal(s.place, (g.winnerTeam === 'strays') === (p.role === 'stray') ? 1 : 2, `${label} recap place`);
  }
}

// Same loop rooms.js runs: one waiting bot acts at a time; with nobody waiting the stage timer fires.
function playStrays(g, maxSteps = 2000) {
  for (let step = 0; step < maxSteps; step += 1) {
    if (g.phase === 'finished') return step;
    const bot = g.waitingOn().map((id) => g.playerById(id))[0];
    if (!bot) { g.onTimer(); continue; }
    if (g.stage === 'day') g.vote(bot.id, straysBrain.chooseVote(g, bot));
    else if (bot.role === 'vet') { const t = straysBrain.choosePeek(g, bot); if (t) g.peek(bot.id, t); }
    else { const t = straysBrain.choosePick(g, bot); if (t) g.pick(bot.id, t); }
    if (g.waitingOn().includes(bot.id)) g.onTimer();   // bot had no legal move: let the timer resolve
  }
  return -1;
}

test('strays: bot games finish with a consistent winning team', () => {
  for (const n of [4, 6, 8, 10]) {
    for (let r = 0; r < 10; r += 1) {
      const g = new StraysGame(seats(n));
      assert.notEqual(playStrays(g), -1, `${n}p did not finish`);
      checkStraysEnd(g, `${n}p`);
    }
  }
});

test('strays: a table where nobody acts still ends on timers alone', () => {
  for (const n of [4, 10]) {
    const g = new StraysGame(seats(n));
    for (let i = 0; i < 200 && g.phase !== 'finished'; i += 1) g.onTimer();
    checkStraysEnd(g, `${n}p idle`);
    assert.equal(g.winnerTeam, 'strays', 'all-skip days never catch a Stray');
  }
});

test('strays: snapshots show a House Cat only their own role', () => {
  const g = new StraysGame(seats(6));
  const me = g.players.find((p) => p.role === 'house');
  const roles = g.snapshotFor(me.id).players.filter((p) => p.role !== null).map((p) => p.id);
  assert.deepEqual(roles, [me.id]);
});
