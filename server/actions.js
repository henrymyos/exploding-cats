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
const ACTIONABLE = new Set([
  'SKIP', 'ATTACK', 'FAVOR', 'SHUFFLE', 'FUTURE',
  'TARGETED_ATTACK', 'ALTER', 'DRAW_BOTTOM', // Party Pack
  'REVERSE', 'MARK', 'SWAP_TB', // expansions
]);
// Action cards that need the player to pick a target.
const NEEDS_TARGET = new Set(['FAVOR', 'TARGETED_ATTACK', 'MARK']);

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

  // ---- Cat combo (all selected cards are cats or wild Feral Cats) ----
  if (cards.every((c) => c.type === 'CAT' || c.type === 'FERAL')) {
    return this.playCatCombo(player, cards, opts);
  }

  // ---- Single action card ----
  if (cards.length !== 1) return err('You can only play one action card at a time.');
  const card = cards[0];

  if (card.type === 'DEFUSE') return err('Defuse can only be used when you draw an Exploding Kitten.');
  if (card.type === 'EXPLODE') return err('You cannot play that.');
  if (card.type === 'NOPE') return err('A Nope can only interrupt another action.');
  if (!ACTIONABLE.has(card.type)) return err('That card has no solo action.');

  // Some cards need the player to pick a target.
  let target = null;
  if (NEEDS_TARGET.has(card.type)) {
    target = this.playerById(opts.targetId);
    if (!target || !target.alive || target.id === player.id) return err('Choose a valid player.');
    if (card.type === 'FAVOR' && target.hand.length === 0) return err('That player has no cards to give.');
  }

  // Move card to discard and open the Nope window.
  this.removeCardFromHand(player, card.id);
  this.discard.push(card);
  this.lastDiscardBy = player.id;
  this.logMsg(`${player.name} played ${card.name}.`);

  this.actionSeq = (this.actionSeq || 0) + 1;
  this.pending = {
    kind: 'action',
    actorId: player.id,
    seq: this.actionSeq,
    nopes: [],
    declined: [],
    endsAt: Date.now() + NOPE_WINDOW_MS,
    description: this.describeAction(card.type, player, target),
    action: { type: card.type, targetId: target ? target.id : null },
  };
  return ok({ window: true });
};

Game.prototype.playCatCombo = function playCatCombo(player, cards, opts) {
  if (cards.length !== 2 && cards.length !== 3) {
    return err('Play 2 matching cats (random steal) or 3 (named steal).');
  }
  // Feral Cats are wild: the real cats among the combo must all match, but a
  // Feral can stand in for any of them. (Two Ferals together also form a pair.)
  const realCats = cards.filter((c) => c.type === 'CAT');
  if (!cards.every((c) => c.type === 'CAT' || c.type === 'FERAL')) {
    return err('Only cat cards can be combined.');
  }
  if (realCats.length && !realCats.every((c) => c.cat === realCats[0].cat)) {
    return err('Cat cards must match (Feral Cats are wild).');
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
  this.lastDiscardBy = player.id;
  const mode = cards.length === 2 ? 'random' : 'named';
  const comboName = (realCats[0] && realCats[0].name) || 'Feral Cat';
  this.logMsg(
    `${player.name} played ${cards.length} ${comboName} cards on ${target.name}.`
  );

  this.actionSeq = (this.actionSeq || 0) + 1;
  this.pending = {
    kind: 'action',
    actorId: player.id,
    seq: this.actionSeq,
    nopes: [],
    declined: [],
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
  if (!this.pending || this.pending.kind !== 'action') return err('Nothing to Nope right now.');
  const player = this.playerById(playerId);
  if (!player || !player.alive) return err('You are out of the game.');

  // You can't Nope your own most recent play (your own action, or your own Nope).
  const nopes = this.pending.nopes;
  const lastActor = nopes.length ? nopes[nopes.length - 1] : this.pending.actorId;
  if (lastActor === playerId) return err('You cannot Nope your own action.');

  const card = player.hand.find((c) => c.type === 'NOPE');
  if (!card) return err('You have no Nope card.');

  this.removeCardFromHand(player, card.id);
  this.discard.push(card);
  this.lastDiscardBy = playerId; // the Nope flies from whoever played it
  this.pending.nopes.push(playerId);
  this.pending.declined = []; // the chain advanced — everyone gets to decide again
  this.pending.endsAt = Date.now() + NOPE_WINDOW_MS; // reopen the window for a counter-Nope
  const state = this.pending.nopes.length % 2 === 1 ? 'cancelled' : 'back on';
  this.logMsg(`${player.name} played Nope! The action is now ${state}.`);
  return ok({ window: true });
};

// A player declines to Nope the current action. Recording this lets the room
// resolve early once nobody eligible still wants to interrupt, instead of
// waiting out the full window.
Game.prototype.declineNope = function declineNope(playerId) {
  if (!this.pending || this.pending.kind !== 'action') return err('Nothing to decline right now.');
  const player = this.playerById(playerId);
  if (!player || !player.alive) return err('You are out of the game.');
  const nopes = this.pending.nopes;
  const lastActor = nopes.length ? nopes[nopes.length - 1] : this.pending.actorId;
  if (lastActor === playerId) return ok({}); // not eligible anyway; nothing to record
  if (!this.pending.declined) this.pending.declined = [];
  if (!this.pending.declined.includes(playerId)) this.pending.declined.push(playerId);
  return ok({});
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
    this.logMsg(`${actor ? actor.name : 'The'} action was cancelled by a Nope.`);
    this.pending = null;
    return;
  }

  this.pending = null;
  const a = p.action;
  // top card right now (skip/attack leave it in place for the next player)
  const topNow = this.deck.length ? this.deck[this.deck.length - 1] : null;

  switch (a.type) {
    case 'SKIP':
      // peeked, then bailed on the draw -> the top is probably an Exploding Cat
      if (this.turnPeeked && topNow) this.suspectTopId = topNow.id;
      this.advanceTurn();
      break;
    case 'ATTACK': {
      if (this.turnPeeked && topNow) this.suspectTopId = topNow.id;
      this.turnPeeked = false;
      // Official rule: the next player takes the attacker's remaining ATTACK-imposed
      // turns plus 2. A normal (non-attacked) turn contributes 0, so it stacks
      // 2 -> 4 -> 6. (A normal player's own single turn isn't passed along.)
      const imposed = this.turnsFromAttack ? this.turnsRemaining : 0;
      const carry = imposed + 2;
      this.nextAlive(this.direction);
      this.turnsRemaining = carry;
      this.turnsFromAttack = true;
      this.logMsg(`${this.currentPlayer().name} must take ${carry} turns!`);
      break;
    }
    case 'REVERSE':
      // flip the turn order and end this turn without drawing (a Skip in 2-player)
      this.direction *= -1;
      this.logMsg('🔄 Turn order reversed!');
      this.advanceTurn();
      break;
    case 'MARK':
      this.resolveMark(actor, a);
      break;
    case 'SWAP_TB':
      if (this.deck.length >= 2) {
        const t = this.deck.length - 1;
        [this.deck[0], this.deck[t]] = [this.deck[t], this.deck[0]];
        this.suspectTopId = null;
        this.logMsg('🔃 The top and bottom of the deck were swapped.');
      }
      break;
    case 'SHUFFLE':
      shuffle(this.deck);
      this.shuffleSeq = (this.shuffleSeq || 0) + 1;
      this.suspectTopId = null; // the suspected card moved somewhere unknown
      this.defuseWary = 0;      // and a re-hidden kitten is no longer near the top
      this.logMsg('The draw pile was shuffled.');
      break;
    case 'FUTURE':
      this.turnPeeked = true; // this player now knows the top of the deck
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
    case 'TARGETED_ATTACK': {
      // Like Attack, but the attacker chose exactly who suffers it.
      if (this.turnPeeked && topNow) this.suspectTopId = topNow.id;
      this.turnPeeked = false;
      const imposed = this.turnsFromAttack ? this.turnsRemaining : 0;
      const carry = imposed + 2;
      const ti = this.players.findIndex((pl) => pl.id === a.targetId && pl.alive);
      if (ti >= 0) this.turnIndex = ti; else this.nextAlive(this.direction);
      this.turnsRemaining = carry;
      this.turnsFromAttack = true;
      this.logMsg(`${this.currentPlayer().name} was targeted — they must take ${carry} turns!`);
      break;
    }
    case 'ALTER':
      this.turnPeeked = true; // altering also reveals the top to this player
      this.pending = {
        kind: 'alter',
        actorId: p.actorId,
        viewerId: p.actorId,
        futureCards: this.deck.slice(-3).reverse(), // top-first
        endsAt: Date.now() + 25000,
        description: `${actor.name} is altering the future.`,
      };
      break;
    case 'DRAW_BOTTOM': {
      // Draw the BOTTOM card to end the turn instead of the top one.
      const card = this.deck.shift(); // bottom (top of deck is the array's end)
      if (card) this.resolveDraw(actor, card);
      break;
    }
    default:
      break;
  }
  this.checkWin();
};

// Reorder the top three cards after an Alter the Future. `order` is the new
// top-first list of the (up to) three card ids the viewer saw.
Game.prototype.alterFuture = function alterFuture(playerId, order) {
  if (!this.pending || this.pending.kind !== 'alter') return err('Nothing to alter.');
  if (this.pending.viewerId !== playerId) return err('Not your alter.');
  const n = Math.min(3, this.deck.length);
  const top = this.deck.slice(this.deck.length - n); // array order (bottom..top of the three)
  if (Array.isArray(order) && order.length === n) {
    const byId = {};
    top.forEach((c) => { byId[c.id] = c; });
    if (order.every((id) => byId[id])) {
      // order is top-first; the deck's end is the top, so end = order[0].
      for (let i = 0; i < n; i += 1) this.deck[this.deck.length - 1 - i] = byId[order[i]];
    }
  }
  this.pending = null;
  return ok();
};

Game.prototype.alterAuto = function alterAuto() {
  if (this.pending && this.pending.kind === 'alter') this.pending = null;
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
      this.recordTransfer(stolen, target, actor);
      this.logMsg(`${actor.name} demanded and took a ${stolen.name} from ${target.name}.`);
      this.checkStreakLoss(target);
      this.checkStreakLoss(actor); // grabbing a streaker's live kitten lands it on you
    }
  }
};

// Mark: the actor blind-picks one of the target's face-down cards (like a steal),
// and that card is flipped face-up for everyone for the rest of the game.
Game.prototype.resolveMark = function resolveMark(actor, a) {
  const target = this.playerById(a.targetId);
  if (!target || !target.alive || target.hand.length === 0) {
    this.logMsg('The mark fizzled — no card to reveal.');
    return;
  }
  const hidden = target.hand.filter((c) => !c.marked);
  if (!hidden.length) { this.logMsg(`${target.name}'s hand is already all marked.`); return; }
  this.pending = {
    kind: 'markPick',
    actorId: actor.id,
    targetId: target.id,
    endsAt: Date.now() + 20000,
    description: `${actor.name} is choosing a card to flip face-up in ${target.name}'s hand.`,
  };
};

// The actor flips a chosen face-down card in the target's hand face-up.
Game.prototype.markTake = function markTake(playerId, index) {
  if (!this.pending || this.pending.kind !== 'markPick') return err('No mark to resolve.');
  if (this.pending.actorId !== playerId) return err('Not your mark.');
  const actor = this.playerById(this.pending.actorId);
  const target = this.playerById(this.pending.targetId);
  const hidden = target ? target.hand.filter((c) => !c.marked) : [];
  if (!hidden.length) { this.pending = null; this.checkWin(); return ok(); }
  let i = Number.isInteger(index) ? index : Math.floor(Math.random() * hidden.length);
  i = Math.max(0, Math.min(i, hidden.length - 1));
  const card = hidden[i];
  card.marked = true; // stays revealed to everyone for the rest of the game
  this.logMsg(`🔖 ${actor.name} flipped ${target.name}'s ${card.name} face-up for all to see.`);
  this.pending = null;
  this.checkWin();
  return ok();
};

Game.prototype.markAuto = function markAuto() {
  if (this.pending && this.pending.kind === 'markPick') {
    const target = this.playerById(this.pending.targetId);
    const hidden = target ? target.hand.filter((c) => !c.marked) : [];
    this.markTake(this.pending.actorId, hidden.length ? Math.floor(Math.random() * hidden.length) : 0);
  }
};

// Note the most recent card-take so both players can be shown which card moved.
Game.prototype.recordTransfer = function recordTransfer(card, fromP, toP) {
  this.transferSeq = (this.transferSeq || 0) + 1;
  this.lastTransfer = {
    seq: this.transferSeq,
    card: { type: card.type, cat: card.cat, name: card.name },
    fromId: fromP.id,
    toId: toP.id,
    fromName: fromP.name,
    toName: toP.name,
  };
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
  this.recordTransfer(stolen, target, actor);
  this.logMsg(`${actor.name} swiped a card from ${target.name}.`);
  this.pending = null;
  this.checkStreakLoss(target);
  this.checkStreakLoss(actor); // a blind grab can land a streaker's live kitten on you
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
  this.recordTransfer(card, target, actor);
  this.logMsg(`${target.name} gave a card to ${actor.name}.`);
  this.pending = null;
  this.checkStreakLoss(target);
  this.checkStreakLoss(actor); // a begged kitten still explodes its new holder
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
  let card = this.deck.pop(); // top of the deck is the array's end
  if (!card) {
    // The pile ran dry. Anyone clinging to a live Exploding Kitten (via a
    // Streaking Kitten) finally faces it — their luck has run out — which keeps
    // the game terminating. Otherwise recycle the discard so play continues.
    const live = player.hand.find((c) => c.type === 'EXPLODE');
    if (live) {
      // Pile's empty and they're secretly sitting on a live kitten — it catches up
      // with them. The explosion below announces itself; don't pre-leak the streak.
      this.removeCardFromHand(player, live.id);
      return this.resolveDraw(player, live, true); // no streak save this time
    }
    this.recycleDiscard();
    card = this.deck.pop();
    if (!card) { this.advanceTurn(); this.checkWin(); return ok({ exploded: false }); }
  }
  return this.resolveDraw(player, card);
};

// Shuffle the discard pile (minus its top card, kept for display) back into the
// draw pile when the deck empties, so the game never deadlocks.
Game.prototype.recycleDiscard = function recycleDiscard() {
  if (this.discard.length <= 1) return;
  const top = this.discard.pop();
  this.deck = shuffle(this.discard.splice(0));
  this.discard = [top];
  this.shuffleSeq = (this.shuffleSeq || 0) + 1;
  this.recycleCount += 1;
  this.logMsg('The draw pile ran out — the discards were shuffled back in.');
  // Endgame escalation so Streaking/Zombie games converge: once the pile recycles
  // the dead stay dead, and after a second lap a Streaking Kitten no longer saves
  // you — so every lap thins the field toward a winner. Only mention the rule that
  // an enabled expansion actually changes (otherwise it's confusing noise).
  if (this.recycleCount === 1 && this.hasExp('zombie')) {
    this.logMsg('With the pile recycled, the dead can no longer be revived.');
  }
  if (this.recycleCount === 2 && this.hasExp('streaking')) {
    this.logMsg('Second recycle — streaking no longer protects you. Sudden death!');
  }
};

// Apply a freshly-drawn card (from the top or, for Draw From the Bottom, the
// bottom): explode + reveal, or land it in the hand and pause on it.
Game.prototype.resolveDraw = function resolveDraw(player, card, noStreak) {
  // this draw consumes a card, so any standing suspicion about it is settled
  if (this.suspectTopId === card.id) this.suspectTopId = null;
  if (this.defuseWary > 0) this.defuseWary -= 1; // post-defuse caution fades as cards come off

  // Imploding Kitten: can't be defused. First draw flips it face-up and you put
  // it back; the next person to draw it is gone for good.
  if (card.type === 'IMPLODE') {
    if (!card.revealed) {
      card.revealed = true;
      this.logMsg(`☢️ ${player.name} drew the Imploding Kitten! It's now face-up — they must put it back.`);
      this.pending = {
        kind: 'implodePlace',
        actorId: player.id,
        card,
        maxIndex: this.deck.length,
        endsAt: Date.now() + 20000,
        description: `${player.name} is sliding the face-up Imploding Kitten back into the deck.`,
      };
      return ok({ implodeReveal: true });
    }
    this.logMsg(`☢️💥 ${player.name} drew the face-up Imploding Kitten — no escape!`);
    this.pending = { kind: 'implode', actorId: player.id, explodeCard: card, endsAt: Date.now() + 6000 };
    return ok({ imploded: true });
  }

  if (card.type === 'EXPLODE') {
    // A Streaking Kitten lets you secretly keep a live Exploding Kitten instead of
    // dying — until the deck recycles twice (sudden death). (Expansion only.)
    if (!noStreak && this.recycleCount < 2 && player.hand.some((c) => c.type === 'STREAK')) {
      player.hand.push(card);
      // Kept SECRET: no public log. To the table this is an ordinary draw; only
      // the holder sees (in their private draw reveal) that it's a live kitten.
      this.logMsg(`${player.name} drew a card.`);
      this.pending = { kind: 'drawn', actorId: player.id, card, streaked: true, endsAt: Date.now() + 30000 };
      return ok({ exploded: false, card, streaked: true });
    }
    // Reveal the Exploding Kitten to everyone first (dramatic pause), then resolve.
    this.logMsg(`💥 ${player.name} drew an Exploding Kitten!`);
    this.pending = {
      kind: 'explode',
      actorId: player.id,
      explodeCard: card,
      hasDefuse: player.hand.some((c) => c.type === 'DEFUSE' || c.type === 'ZOMBIE'),
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
  this.lastDiscardBy = player.id;
  const zombie = this.hasExp('zombie') ? player.hand.find((c) => c.type === 'ZOMBIE') : null;
  if (defuse) {
    this.removeCardFromHand(player, defuse.id);
    this.discard.push(defuse);
    this.logMsg(`😼 ${player.name} played a Defuse and survived!`);
    this.pending = {
      kind: 'defuse',
      actorId: player.id,
      explodeCard: card,
      endsAt: Date.now() + 20000,
      description: `${player.name} is sneaking the Exploding Kitten back into the deck.`,
    };
  } else if (zombie) {
    // Zombie Kitten: survive AND drag a dead player back into the game.
    this.removeCardFromHand(player, zombie.id);
    this.discard.push(zombie);
    this.logMsg(`🧟 ${player.name} played a Zombie Kitten and clawed back from the brink!`);
    this.resurrectOne();
    this.pending = {
      kind: 'defuse',
      actorId: player.id,
      explodeCard: card,
      endsAt: Date.now() + 20000,
      description: `${player.name} is hiding the Exploding Kitten back in the deck.`,
    };
  } else {
    this.eliminate(player, card, '💥', 'exploded');
    this.pending = null;
    this.checkWin();
  }
};

// Bring the longest-dead player back to life with a single Defuse to start.
// Once the deck has recycled, the dead stay dead so the game can converge.
Game.prototype.resurrectOne = function resurrectOne() {
  if (this.recycleCount >= 1) return;
  while (this.deadOrder.length) {
    const id = this.deadOrder.shift();
    const p = this.playerById(id);
    if (p && !p.alive) {
      p.alive = true;
      p.hand = [this.makeOne('DEFUSE')];
      this.logMsg(`🧟 ${p.name} was dragged back to life!`);
      return;
    }
  }
};

// Knock a player out: discard their hand, mark them dead, and pass the turn.
// In Zombie mode they can still be dragged back later (see Zombie Kitten).
Game.prototype.eliminate = function eliminate(player, card, icon, verb) {
  while (player.hand.length) this.discard.push(player.hand.pop());
  if (card) this.discard.push(card);
  player.alive = false;
  if (!this.deadOrder.includes(player.id)) this.deadOrder.push(player.id);
  this.logMsg(`${icon || '💥'} ${player.name} ${verb || 'is out'}! Their cards go to the discard pile.`);
  this.turnsRemaining = 1;
  this.turnsFromAttack = false; // their attack-turns die with them
  this.nextAlive(this.direction);
};

// If a player loses their last Streaking Kitten while holding a live Exploding
// Kitten, the cat's out of the bag and they explode. Call after any card leaves
// a hand via Favor/steal.
Game.prototype.checkStreakLoss = function checkStreakLoss(player) {
  if (!player || !player.alive) return;
  const kitten = player.hand.some((c) => c.type === 'EXPLODE');
  const streak = player.hand.some((c) => c.type === 'STREAK');
  if (kitten && !streak) {
    while (player.hand.length) this.discard.push(player.hand.pop());
    player.alive = false;
    if (!this.deadOrder.includes(player.id)) this.deadOrder.push(player.id);
    this.lastDiscardBy = player.id;
    this.logMsg(`💥 ${player.name} was caught holding an Exploding Kitten with no Streaking Kitten — and exploded!`);
    if (this.currentPlayer() && this.currentPlayer().id === player.id) {
      this.turnsRemaining = 1; this.turnsFromAttack = false; this.nextAlive(this.direction);
    }
  }
};

// ---- Imploding Kitten (un-defusable) ----

// First draw: slide the now-face-up Imploding Kitten back into the deck.
Game.prototype.implodePlace = function implodePlace(playerId, index) {
  if (!this.pending || this.pending.kind !== 'implodePlace') return err('Nothing to place.');
  if (this.pending.actorId !== playerId) return err('Not your Imploding Kitten.');
  const card = this.pending.card;
  let i = Number.isInteger(index) ? index : Math.floor(Math.random() * (this.deck.length + 1));
  i = Math.max(0, Math.min(i, this.deck.length));
  this.deck.splice(this.deck.length - i, 0, card); // index 0 = top (array end)
  this.logMsg('The face-up Imploding Kitten is back in the deck — whoever draws it next is done for.');
  this.defuseWary = 3;
  this.pending = null;
  this.advanceTurn();
  this.checkWin();
  return ok();
};

Game.prototype.implodePlaceAuto = function implodePlaceAuto() {
  if (this.pending && this.pending.kind === 'implodePlace') {
    this.implodePlace(this.pending.actorId, Math.floor(Math.random() * (this.deck.length + 1)));
  }
};

// Second draw of the face-up Imploding Kitten — no defuse, you're gone.
Game.prototype.resolveImplode = function resolveImplode(playerId) {
  if (!this.pending || this.pending.kind !== 'implode') return err('Nothing to resolve.');
  if (playerId && this.pending.actorId !== playerId) return err('Not your implosion.');
  this.applyImplode();
  return ok();
};

Game.prototype.applyImplode = function applyImplode() {
  if (!this.pending || this.pending.kind !== 'implode') return;
  const player = this.playerById(this.pending.actorId);
  this.lastDiscardBy = player.id;
  this.eliminate(player, this.pending.explodeCard, '☢️', 'imploded — no defuse could save them');
  this.pending = null;
  this.checkWin();
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
  this.logMsg(`The Exploding Kitten is back in the deck somewhere...`);
  // a kitten was just hidden back in the deck (defusers love the top) — make the
  // next few draws "wary" so bots peek/dodge instead of blindly drawing into it.
  this.defuseWary = 3;
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
    case 'TARGETED_ATTACK':
      return `${player.name} is targeting ${target ? target.name : 'someone'} with extra turns.`;
    case 'ALTER':
      return `${player.name} is rearranging the top of the deck.`;
    case 'DRAW_BOTTOM':
      return `${player.name} is drawing from the bottom of the deck.`;
    case 'REVERSE':
      return `${player.name} is reversing the turn order.`;
    case 'MARK':
      return `${player.name} is marking a card in ${target ? target.name : "someone"}'s hand.`;
    case 'SWAP_TB':
      return `${player.name} is swapping the top and bottom of the deck.`;
    default:
      return `${player.name} played a card.`;
  }
};

module.exports = { NOPE_WINDOW_MS };
