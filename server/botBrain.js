'use strict';

/*
 * Bot decision logic. Pure functions over a Game + a bot player.
 * The room manager calls these and applies the result via the normal
 * Game methods, so bots play by exactly the same rules as humans.
 *
 * Bots only use information a fair human player would also know:
 * how many Exploding Cats are unaccounted for and how big the deck is.
 */

function rnd() {
  return Math.random();
}

// Fair, publicly-derivable risk that the very next draw is fatal (Exploding or
// Imploding Kitten).
function explodeRisk(game) {
  const inDeck = game.deck.length;
  if (inDeck === 0) return 1;
  const kittens = game.deck.filter((c) => c.type === 'EXPLODE' || c.type === 'IMPLODE').length;
  return kittens / inDeck;
}

function aliveTargets(game, bot) {
  return game.players.filter((p) => p.alive && p.id !== bot.id && p.hand.length > 0);
}

function richest(targets) {
  return targets.slice().sort((a, b) => b.hand.length - a.hand.length)[0];
}

// Find two cards that form a steal pair; returns [id, id] or null.
// Feral Cats are wild (Party Pack): cat+feral or feral+feral also pair up.
function findCatPair(hand) {
  const byCat = {};
  const ferals = [];
  for (const c of hand) {
    if (c.type === 'FERAL') ferals.push(c.id);
    else if (c.type === 'CAT') (byCat[c.cat] = byCat[c.cat] || []).push(c.id);
  }
  for (const cat of Object.keys(byCat)) {
    if (byCat[cat].length >= 2) return byCat[cat].slice(0, 2);
  }
  const anyCat = Object.values(byCat).find((ids) => ids.length);
  if (ferals.length && anyCat) return [anyCat[0], ferals[0]]; // real cat + wild
  if (ferals.length >= 2) return [ferals[0], ferals[1]];      // two wilds
  return null;
}

// Find three cards for a named-demand combo (cats matching, Ferals wild).
function findCatTrio(hand) {
  const byCat = {};
  const ferals = [];
  for (const c of hand) {
    if (c.type === 'FERAL') ferals.push(c.id);
    else if (c.type === 'CAT') (byCat[c.cat] = byCat[c.cat] || []).push(c.id);
  }
  for (const cat of Object.keys(byCat)) {
    const need = byCat[cat].concat(ferals);
    if (byCat[cat].length >= 1 && need.length >= 3) return need.slice(0, 3);
  }
  if (ferals.length >= 3) return ferals.slice(0, 3);
  return null;
}

// A live opponent publicly known to be holding a kitten via a Streaking Kitten.
function streakingTarget(game, bot) {
  return game.players.find((p) => p.alive && p.id !== bot.id && p.streaking);
}

// What the bot wants to do on its own turn — one action per call.
function chooseTurnAction(game, bot) {
  const hand = bot.hand;
  const has = (t) => hand.find((c) => c.type === t);
  const play = (c) => ({ kind: 'play', cardIds: [c.id] });
  const skip = has('SKIP');
  const attack = has('ATTACK');
  const future = has('FUTURE');
  const favor = has('FAVOR');
  const shuffle = has('SHUFFLE');
  const hasDefuse = !!has('DEFUSE');
  // Party Pack cards
  const targetedAttack = has('TARGETED_ATTACK');
  const alter = has('ALTER');
  const drawBottom = has('DRAW_BOTTOM');
  const peeker = future || alter; // either card lets us look at the top of the deck
  // Expansion cards
  const reverse = has('REVERSE');
  const swap = has('SWAP_TB');
  const mark = has('MARK');

  const top = game.deck[game.deck.length - 1];
  // Memory now holds every card seen in the last peek, so after drawing one the
  // bot still recognises the new top (no needless re-peek). Invalid after a shuffle.
  const mem = game.botMemory[bot.id];
  const memValid = mem && Array.isArray(mem.known) && mem.shuffleSeq === (game.shuffleSeq || 0);
  const knownEntry = memValid && top ? mem.known.find((k) => k.id === top.id) : null;
  const knownType = knownEntry ? knownEntry.type : null;
  const knownExplodeTop = knownType === 'EXPLODE' || knownType === 'IMPLODE';
  const knownSafeTop = !!knownType && knownType !== 'EXPLODE' && knownType !== 'IMPLODE';
  // Public inference: someone peeked at the future and then dodged their draw —
  // the top is almost certainly an Exploding Cat. (Our own peek, if it says safe,
  // overrides this.)
  const suspectTop = !knownSafeTop && top && game.suspectTopId === top.id;
  // Right after someone defuses a kitten back into the deck (often near the top),
  // treat the next draws as riskier than the raw odds — be wary and peek/dodge.
  const wary = game.defuseWary || 0;
  const risk = Math.min(1, explodeRisk(game) + 0.11 * wary);

  const targets = aliveTargets(game, bot);
  const targetAttackOn = () => {
    const t = richest(targets);
    return t ? { kind: 'play', cardIds: [targetedAttack.id], opts: { targetId: t.id } } : null;
  };

  // A way to avoid drawing the current top, best option first. bottomOk allows a
  // Draw From the Bottom — only useful when it's the TOP specifically that's bad.
  const dodge = (bottomOk) => {
    if (skip) return play(skip);
    if (reverse) return play(reverse); // ends the turn like a Skip
    if (attack) return play(attack);
    if (targetedAttack && targets.length) return targetAttackOn();
    if (bottomOk && drawBottom) return play(drawBottom); // sidestep a known-bad top
    if (bottomOk && swap) return play(swap);             // shove the bad top to the bottom
    if (shuffle) return play(shuffle); // scramble the bad top out of the way
    return null;
  };

  // 1. The next card is (or is very likely) an Exploding Cat — don't draw into it.
  //    Dodge even if we hold a Defuse, to save the Defuse for a surprise later.
  if (knownExplodeTop || suspectTop) {
    const d = dodge(true);
    if (d) return d;
    // Can't dodge. If we only *suspect* (no certainty) and can peek, confirm first.
    if (suspectTop && !knownExplodeTop && peeker) return play(peeker);
    // Otherwise we draw: survive on a Defuse, or it's a forced loss.
  }

  // 2. Peek (or alter) when we don't already know the top and a draw looks risky.
  if (!knownType && !suspectTop && peeker && (risk > 0.18 || rnd() < 0.22)) {
    return play(peeker);
  }

  // 3a. A rival is streaking a live kitten — if we can demand their Streaking
  //     Kitten with a three-of-a-kind, do it: they lose the streak and explode.
  const streaker = streakingTarget(game, bot);
  if (streaker) {
    const trio = findCatTrio(hand);
    if (trio) return { kind: 'play', cardIds: trio, opts: { targetId: streaker.id, namedType: 'STREAK' } };
  }

  // 3. Cash in a matching cat pair to steal. Prefer a streaking rival (a blind
  //    steal might grab their Streaking Kitten and pop them).
  const pair = findCatPair(hand);
  if (pair && targets.length && rnd() < 0.6) {
    const tgt = streaker || richest(targets);
    return { kind: 'play', cardIds: pair, opts: { targetId: tgt.id } };
  }

  // 4. Beg a card sometimes.
  if (favor && targets.length && rnd() < 0.4) {
    return { kind: 'play', cardIds: [favor.id], opts: { targetId: richest(targets).id } };
  }

  // 4b. Expansion flavour: occasionally Mark the leader's hand or Swap the deck.
  if (mark && targets.length && rnd() < 0.25) {
    return { kind: 'play', cardIds: [mark.id], opts: { targetId: richest(targets).id } };
  }
  if (swap && !knownSafeTop && rnd() < 0.12) return play(swap);

  // 5. Don't know the top is safe and the deck is dangerous — bail out if we can.
  if (!knownSafeTop && risk > 0.35) {
    const d = dodge();
    if (d) return d;
  }

  // 6. Otherwise, just draw and end the turn.
  return { kind: 'draw' };
}

// Should this bot interrupt the current action with a Hiss?
function chooseNope(game, bot) {
  const p = game.pending;
  if (!p || p.kind !== 'action') return false;
  if (p.actorId === bot.id) return false;
  if (!bot.hand.some((c) => c.type === 'NOPE')) return false;

  const cancelled = p.nopes.length % 2 === 1;
  if (cancelled) return false; // don't re-enable an action that's already been cancelled

  const a = p.action || {};
  // Something is being done TO this bot (begged from / stolen from).
  if (a.targetId === bot.id) return rnd() < 0.8;
  // An Attack that would dump extra turns onto this bot.
  if (a.type === 'ATTACK' && nextAliveId(game) === bot.id) return rnd() < 0.5;
  return false;
}

// Which card to surrender for a Favor — give up the least useful thing.
function chooseFavorCard(game, bot) {
  const hand = bot.hand;
  const counts = {};
  for (const c of hand) if (c.type === 'CAT') counts[c.cat] = (counts[c.cat] || 0) + 1;
  const singleCat = hand.find((c) => c.type === 'CAT' && counts[c.cat] === 1);
  if (singleCat) return singleCat.id;
  // never hand over the cards that keep you alive (or a live kitten you're holding)
  const PRECIOUS = new Set(['DEFUSE', 'NOPE', 'STREAK', 'ZOMBIE', 'EXPLODE', 'IMPLODE']);
  const meh = hand.find((c) => !PRECIOUS.has(c.type));
  if (meh) return meh.id;
  const nonVital = hand.find((c) => c.type !== 'DEFUSE' && c.type !== 'STREAK' && c.type !== 'ZOMBIE');
  return (nonVital || hand[0]).id;
}

// Where to hide a defused Exploding Cat — often right on top, to ambush the next player.
function chooseDefuseIndex(game) {
  if (rnd() < 0.45) return 0; // top of the deck: next player draws it
  return Math.floor(rnd() * (game.deck.length + 1));
}

// The id of whoever would take the next turn after the current player.
function nextAliveId(game) {
  const n = game.players.length;
  let i = game.turnIndex;
  for (let step = 0; step < n; step += 1) {
    i = (i + 1) % n;
    if (game.players[i].alive) return game.players[i].id;
  }
  return null;
}

module.exports = {
  chooseTurnAction,
  chooseNope,
  chooseFavorCard,
  chooseDefuseIndex,
};
