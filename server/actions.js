'use strict';

/*
 * Game action logic, attached to the Game prototype.
 * Pure state transitions — the room manager owns the timers and broadcasting.
 *
 * Every method returns { ok: true, ... } or { ok: false, error }.
 */

const { Game, shuffle } = require('./game');

const NOPE_WINDOW_MS = 5000;

function ok(extra = {}) {
  return { ok: true, ...extra };
}
function err(message) {
  return { ok: false, error: message };
}

// Cards that, when played, open a Hiss (Nope) window.
const ACTIONABLE = new Set(['SKIP', 'ATTACK', 'FAVOR', 'SHUFFLE', 'FUTURE']);

// ------------------------------------------------------------------
// Playing cards from hand
// ------------------------------------------------------------------

/**
 * Play one action card, or a cat combo (2 or 3 matching cat cards).
 * @param {string} playerId
 * @param {string[]} cardIds
 * @param {object} opts  { targetId?, namedType? }
 */
Game.prototype.playCards = function playCards(playerId, cardIds, opts = {}) {
  if (this.phase !== 'playing') return err('The game is over.');
  if (this.pending) return err('Wait for the current action to resolve.');
  if (!this.isCurrent(playerId)) return err('It is not your turn.');
  const player = this.playerById(playerId);
  if (!player || !player.alive) return err('You are out of the game.');
  if (!Array.isArray(cardIds) || cardIds.length === 0) return err('No cards selected.');

  const cards = cardIds.map((id) => player.hand.find((c) => c.id === id)).filter(Boolean);
  if (cards.length !== cardIds.length) return err('You do not hold those cards.');

  // ---- Cat combo (all selected cards are the same cat) ----
  if (cards.every((c) => c.type === 'CAT')) {
    return this.playCatCombo(player, cards, opts);
  }

  // ---- Single action card ----
  if (cards.length !== 1) return err('You can only play one action card at a time.');
  const card = cards[0];

  if (card.type === 'DEFUSE') return err('Catnip can only be used when you draw an Exploding Cat.');
  if (card.type === 'EXPLODE') return err('You cannot play that.');
  if (card.type === 'NOPE') return err('A Hiss can only interrupt another action.');
  if (!ACTIONABLE.has(card.type)) return err('That card has no solo action.');

  // FAVOR needs a target.
  let target = null;
  if (card.type === 'FAVOR') {
    target = this.playerById(opts.targetId);
    if (!target || !target.alive || target.id === player.id) return err('Choose a valid target to beg from.');
    if (target.hand.length === 0) return err('That player has no cards to give.');
  }

  // Move card to discard and open the Hiss window.
  this.removeCardFromHand(player, card.id);
  this.discard.push(card);
  this.logMsg(`${player.name} played ${card.name}.`);

  this.pending = {
    kind: 'action',
    actorId: player.id,
    nopes: [],
    endsAt: Date.now() + NOPE_WINDOW_MS,
    description: this.describeAction(card.type, player, target),
    action: { type: card.type, targetId: target ? target.id : null },
  };
  return ok({ window: true });
};

Game.prototype.playCatCombo = function playCatCombo(player, cards, opts) {
  const catId = cards[0].cat;
  if (!cards.every((c) => c.type === 'CAT' && c.cat === catId)) {
    return err('Cat cards must all match to combo.');
  }
  if (cards.length !== 2 && cards.length !== 3) {
    return err('Play 2 matching cats (random steal) or 3 (named steal).');
  }

  const target = this.playerById(opts.targetId);
  if (!target || !target.alive || target.id === player.id) return err('Choose a valid player to steal from.');
  if (target.hand.length === 0) return err('That player has no cards.');

  if (cards.length === 3 && !opts.namedType) {
    return err('Name a card type to demand for a three-of-a-kind.');
  }

  // Discard the combo.
  for (const c of cards) {
    this.removeCardFromHand(player, c.id);
    this.discard.push(c);
  }
  const mode = cards.length === 2 ? 'random' : 'named';
  this.logMsg(
    `${player.name} played ${cards.length} ${cards[0].name} cards on ${target.name}.`
  );

  this.pending = {
    kind: 'action',
    actorId: player.id,
    nopes: [],
    endsAt: Date.now() + NOPE_WINDOW_MS,
    description:
      mode === 'random'
        ? `${player.name} is stealing a random card from ${target.name}.`
        : `${player.name} is demanding a ${opts.namedType} from ${target.name}.`,
    action: { type: 'STEAL', mode, targetId: target.id, namedType: opts.namedType || null },
  };
  return ok({ window: true });
};

// ------------------------------------------------------------------
// Hiss (Nope)
// ------------------------------------------------------------------

Game.prototype.playNope = function playNope(playerId) {
  if (!this.pending || this.pending.kind !== 'action') return err('Nothing to Hiss at right now.');
  const player = this.playerById(playerId);
  if (!player || !player.alive) return err('You are out of the game.');

  const card = player.hand.find((c) => c.type === 'NOPE');
  if (!card) return err('You have no Hiss card.');

  this.removeCardFromHand(player, card.id);
  this.discard.push(card);
  this.pending.nopes.push(playerId);
  this.pending.endsAt = Date.now() + NOPE_WINDOW_MS; // reopen the window for a counter-Hiss
  const state = this.pending.nopes.length % 2 === 1 ? 'cancelled' : 'back on';
  this.logMsg(`${player.name} hissed! The action is now ${state}.`);
  return ok({ window: true });
};

// ------------------------------------------------------------------
// Resolving the pending action when its window closes
// ------------------------------------------------------------------

Game.prototype.resolveAction = function resolveAction() {
  if (!this.pending || this.pending.kind !== 'action') return;
  const p = this.pending;
  const actor = this.playerById(p.actorId);

  // Odd number of Hisses => the action is cancelled.
  if (p.nopes.length % 2 === 1) {
    this.logMsg(`${actor ? actor.name : 'The'} action was cancelled by a Hiss.`);
    this.pending = null;
    return;
  }

  this.pending = null;
  const a = p.action;

  switch (a.type) {
    case 'SKIP':
      this.advanceTurn();
      break;
    case 'ATTACK': {
      const carry = Math.max(this.turnsRemaining - 1, 0) + 2;
      this.nextAlive(1);
      this.turnsRemaining = carry;
      this.logMsg(`${this.currentPlayer().name} must take ${carry} turns!`);
      break;
    }
    case 'SHUFFLE':
      shuffle(this.deck);
      this.logMsg('The draw pile was shuffled.');
      break;
    case 'FUTURE':
      this.pending = {
        kind: 'future',
        actorId: p.actorId,
        viewerId: p.actorId,
        futureCards: this.deck.slice(-3).reverse(), // top of deck = end of array
        endsAt: Date.now() + 12000,
        description: `${actor.name} is peeking at the future.`,
      };
      break;
    case 'FAVOR':
      this.pending = {
        kind: 'favorPick',
        actorId: p.actorId,
        targetId: a.targetId,
        endsAt: Date.now() + 20000,
        description: `${this.playerById(a.targetId).name} must give a card to ${actor.name}.`,
      };
      break;
    case 'STEAL':
      this.resolveSteal(actor, a);
      break;
    default:
      break;
  }
  this.checkWin();
};

Game.prototype.resolveSteal = function resolveSteal(actor, a) {
  const target = this.playerById(a.targetId);
  if (!target || !target.alive || target.hand.length === 0) {
    this.logMsg('The steal fizzled — no card to take.');
    return;
  }
  if (a.mode === 'random') {
    // Blind pick: the actor chooses a face-down card from the target's hand.
    this.pending = {
      kind: 'stealPick',
      actorId: actor.id,
      targetId: target.id,
      endsAt: Date.now() + 20000,
      description: `${actor.name} is taking a card from ${target.name}.`,
    };
  } else {
    // named: take a card of the requested type/cat if present
    const wanted = a.namedType;
    const idx = target.hand.findIndex((c) => c.type === wanted || c.cat === wanted);
    if (idx === -1) {
      this.logMsg(`${target.name} had no ${wanted} — ${actor.name} gets nothing.`);
    } else {
      const [stolen] = target.hand.splice(idx, 1);
      actor.hand.push(stolen);
      this.logMsg(`${actor.name} demanded and took a ${stolen.name} from ${target.name}.`);
    }
  }
};

// The actor takes a chosen face-down card from the target's hand.
Game.prototype.stealTake = function stealTake(playerId, index) {
  if (!this.pending || this.pending.kind !== 'stealPick') return err('No steal to resolve.');
  if (this.pending.actorId !== playerId) return err('Not your steal.');
  const actor = this.playerById(this.pending.actorId);
  const target = this.playerById(this.pending.targetId);
  if (!target || target.hand.length === 0) { this.pending = null; this.checkWin(); return ok(); }
  let i = Number.isInteger(index) ? index : Math.floor(Math.random() * target.hand.length);
  i = Math.max(0, Math.min(i, target.hand.length - 1));
  const [stolen] = target.hand.splice(i, 1);
  actor.hand.push(stolen);
  this.logMsg(`${actor.name} swiped a card from ${target.name}.`);
  this.pending = null;
  this.checkWin();
  return ok();
};

Game.prototype.stealAuto = function stealAuto() {
  if (this.pending && this.pending.kind === 'stealPick') {
    const target = this.playerById(this.pending.targetId);
    const n = target ? target.hand.length : 0;
    this.stealTake(this.pending.actorId, n ? Math.floor(Math.random() * n) : 0);
  }
};

// ------------------------------------------------------------------
// Favor: target hands over a chosen card
// ------------------------------------------------------------------

Game.prototype.favorGive = function favorGive(playerId, cardId) {
  if (!this.pending || this.pending.kind !== 'favorPick') return err('No favor to fulfil.');
  if (this.pending.targetId !== playerId) return err('You are not the one giving a card.');
  const target = this.playerById(playerId);
  const actor = this.playerById(this.pending.actorId);
  const card = this.removeCardFromHand(target, cardId);
  if (!card) return err('You do not hold that card.');
  actor.hand.push(card);
  this.logMsg(`${target.name} gave a card to ${actor.name}.`);
  this.pending = null;
  this.checkWin();
  return ok();
};

// Auto-resolve a favor if the giver stalls (room manager calls this on timeout).
Game.prototype.favorAuto = function favorAuto() {
  if (!this.pending || this.pending.kind !== 'favorPick') return;
  const target = this.playerById(this.pending.targetId);
  if (target && target.hand.length) {
    const idx = Math.floor(Math.random() * target.hand.length);
    this.favorGive(target.id, target.hand[idx].id);
  } else {
    this.pending = null;
  }
};

// ------------------------------------------------------------------
// Curious Peek (See the Future) dismissal
// ------------------------------------------------------------------

Game.prototype.dismissFuture = function dismissFuture(playerId) {
  if (!this.pending || this.pending.kind !== 'future') return err('Nothing to dismiss.');
  if (this.pending.viewerId !== playerId) return err('Not your peek.');
  this.pending = null;
  return ok();
};

Game.prototype.dismissFutureAuto = function dismissFutureAuto() {
  if (this.pending && this.pending.kind === 'future') this.pending = null;
};

// ------------------------------------------------------------------
// Drawing a card (ends the turn unless you must defuse)
// ------------------------------------------------------------------

Game.prototype.drawCard = function drawCard(playerId) {
  if (this.phase !== 'playing') return err('The game is over.');
  if (this.pending) return err('Resolve the current action first.');
  if (!this.isCurrent(playerId)) return err('It is not your turn.');
  const player = this.playerById(playerId);

  const card = this.deck.pop();
  if (!card) return err('The deck is empty.');

  if (card.type === 'EXPLODE') {
    // Reveal the Exploding Cat to everyone first (dramatic pause), then resolve.
    this.logMsg(`💥 ${player.name} drew an Exploding Cat!`);
    this.pending = {
      kind: 'explode',
      actorId: player.id,
      explodeCard: card,
      hasDefuse: player.hand.some((c) => c.type === 'DEFUSE'),
      endsAt: Date.now() + 6000,
    };
    return ok({ exploded: true });
  }

  player.hand.push(card);
  this.logMsg(`${player.name} drew a card.`);
  // Pause on the drawn card so the player can see it, then they Continue to
  // end the turn. (The card is already in their hand.)
  this.pending = {
    kind: 'drawn',
    actorId: player.id,
    card,
    endsAt: Date.now() + 30000,
  };
  return ok({ exploded: false, card });
};

// After the Exploding Cat has been shown, resolve it: defuse or elimination.
Game.prototype.resolveExplode = function resolveExplode(playerId) {
  if (!this.pending || this.pending.kind !== 'explode') return err('Nothing to resolve.');
  if (playerId && this.pending.actorId !== playerId) return err('Not your explosion.');
  this.applyExplode();
  return ok();
};

Game.prototype.applyExplode = function applyExplode() {
  if (!this.pending || this.pending.kind !== 'explode') return;
  const player = this.playerById(this.pending.actorId);
  const card = this.pending.explodeCard;
  const defuse = player.hand.find((c) => c.type === 'DEFUSE');
  if (defuse) {
    this.removeCardFromHand(player, defuse.id);
    this.discard.push(defuse);
    this.logMsg(`😼 ${player.name} used Catnip to defuse it!`);
    this.pending = {
      kind: 'defuse',
      actorId: player.id,
      explodeCard: card,
      endsAt: Date.now() + 20000,
      description: `${player.name} is sneaking the Exploding Cat back into the deck.`,
    };
  } else {
    this.discard.push(card);
    player.alive = false;
    this.logMsg(`💥 ${player.name} exploded! They are out of the game.`);
    this.turnsRemaining = 1;
    this.nextAlive(1);
    this.pending = null;
    this.checkWin();
  }
};

// End the turn after reviewing a drawn card.
Game.prototype.continueTurn = function continueTurn(playerId) {
  if (!this.pending || this.pending.kind !== 'drawn') return err('Nothing to continue.');
  if (this.pending.actorId !== playerId) return err('Not your draw to continue.');
  this.pending = null;
  this.advanceTurn();
  this.checkWin();
  return ok();
};

Game.prototype.continueTurnAuto = function continueTurnAuto() {
  if (this.pending && this.pending.kind === 'drawn') {
    this.pending = null;
    this.advanceTurn();
    this.checkWin();
  }
};

Game.prototype.defusePlace = function defusePlace(playerId, index) {
  if (!this.pending || this.pending.kind !== 'defuse') return err('Nothing to defuse.');
  if (this.pending.actorId !== playerId) return err('Not your defuse.');
  const card = this.pending.explodeCard;
  let i = Number.isInteger(index) ? index : Math.floor(Math.random() * (this.deck.length + 1));
  i = Math.max(0, Math.min(i, this.deck.length));
  // index 0 = top of deck. Our deck array has the top at the END, so convert.
  const insertAt = this.deck.length - i;
  this.deck.splice(insertAt, 0, card);
  this.logMsg(`The Exploding Cat is back in the deck somewhere...`);
  this.pending = null;
  this.advanceTurn();
  this.checkWin();
  return ok();
};

Game.prototype.defuseAuto = function defuseAuto() {
  if (this.pending && this.pending.kind === 'defuse') {
    this.defusePlace(this.pending.actorId, Math.floor(Math.random() * (this.deck.length + 1)));
  }
};

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

Game.prototype.describeAction = function describeAction(type, player, target) {
  switch (type) {
    case 'SKIP':
      return `${player.name} is scampering away (no draw).`;
    case 'ATTACK':
      return `${player.name} is pouncing — the next player takes extra turns.`;
    case 'SHUFFLE':
      return `${player.name} is shuffling the deck.`;
    case 'FUTURE':
      return `${player.name} is peeking at the top of the deck.`;
    case 'FAVOR':
      return `${player.name} is begging a card from ${target ? target.name : 'someone'}.`;
    default:
      return `${player.name} played a card.`;
  }
};

module.exports = { NOPE_WINDOW_MS };
