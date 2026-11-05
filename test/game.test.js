'use strict';
// Headless checks for the Exploding Cats engine. Run: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../server/game');
require('../server/actions'); // augments Game.prototype
const brain = require('../server/botBrain');
const { EXPANSIONS, resolveDeck } = require('../server/cards');

const seats = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, isBot: true }));
const allCards = (g) => [...g.deck, ...g.players.flatMap((p) => p.hand)];
const count = (cards, type) => cards.filter((c) => c.type === type).length;

// Every subset of the expansions (2^3 = 8).
const expCombos = Object.keys(EXPANSIONS).reduce((acc, k) => acc.concat(acc.map((c) => [...c, k])), [[]]);

test('original deck is the official 56 cards (52 + 4 kittens at 5 players)', () => {
  const g = new Game(seats(5), 'original', []);
  assert.equal(allCards(g).length, 56);
  assert.equal(count(allCards(g), 'EXPLODE'), 4);
  assert.equal(count(allCards(g), 'DEFUSE'), 6);
});

test('party pack picks the paw / non-paw / full tier by player count', () => {
  assert.equal(resolveDeck('party', 3).defuse, 3);
  assert.equal(resolveDeck('party', 4).defuse, 7);
  assert.equal(resolveDeck('party', 7).defuse, 7);
  assert.equal(resolveDeck('party', 8).defuse, 10);
  assert.equal(resolveDeck('bogus', 8).defuse, 6); // unknown mode falls back to original
});

test('deal: 5 cards each with a Defuse, players-1 kittens in the deck', () => {
  for (const mode of ['original', 'party']) {
    for (const n of mode === 'original' ? [2, 5] : [2, 4, 10]) {
      const g = new Game(seats(n), mode, ['imploding']);
      for (const p of g.players) {
        assert.equal(p.hand.length, 5);
        assert.ok(count(p.hand, 'DEFUSE') >= 1);
        assert.equal(count(p.hand, 'EXPLODE'), 0);
      }
      assert.equal(count(g.deck, 'EXPLODE'), n - 1, `${mode} ${n}p`);
      assert.equal(count(g.deck, 'IMPLODE'), 1);
      const ids = allCards(g).map((c) => c.id);
      assert.equal(new Set(ids).size, ids.length, 'card ids are unique');
    }
  }
});

// Drive a bot-only game to the end: pending decisions go through the same
// auto-resolvers rooms.js fires on timeout; turns use the real bot brain.
const AUTO = {
  action: 'resolveAction', future: 'dismissFutureAuto', favorPick: 'favorAuto', defuse: 'defuseAuto',
  drawn: 'continueTurnAuto', explode: 'applyExplode', stealPick: 'stealAuto', markPick: 'markAuto',
  alter: 'alterAuto', implodePlace: 'implodePlaceAuto', implode: 'applyImplode',
};
function playOut(g, maxSteps = 20000) {
  for (let step = 0; step < maxSteps; step += 1) {
    if (g.phase === 'finished') return step;
    const p = g.pending;
    if (p) {
      if (p.kind === 'action') {
        const others = g.alivePlayers().filter((x) => x.id !== p.actorId);
        const noper = others[Math.floor(Math.random() * others.length)];
        if (noper && brain.chooseNope(g, noper) && g.playNope(noper.id).ok) continue;
      }
      assert.ok(AUTO[p.kind], `no resolver for pending kind ${p.kind}`);
      g[AUTO[p.kind]]();
      continue;
    }
    const cur = g.currentPlayer();
    assert.ok(cur && cur.alive, 'current player is alive');
    const a = brain.chooseTurnAction(g, cur);
    const res = a.kind === 'play' ? g.playCards(cur.id, a.cardIds, a.opts || {}) : { ok: false };
    if (!res.ok) g.drawCard(cur.id);
  }
  return -1;
}

test('bot games finish with one living winner for every mode + expansion combo', () => {
  for (const mode of ['original', 'party']) {
    for (const exps of expCombos) {
      for (const n of mode === 'original' ? [2, 5] : [3, 6, 10]) {
        for (let r = 0; r < 3; r += 1) {
          const g = new Game(seats(n), mode, exps);
          const label = `${mode} ${n}p [${exps.join(',')}]`;
          assert.notEqual(playOut(g), -1, `${label} did not finish`);
          const winner = g.playerById(g.winnerId);
          assert.ok(winner && winner.alive, `${label} winner is alive`);
          assert.equal(g.alivePlayers().length, 1, `${label} exactly one survivor`);
        }
      }
    }
  }
});
