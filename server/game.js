'use strict';

const { CARD_DEFS, MODES, EXPANSIONS, resolveDeck, cleanExpansions, catList } = require('./cards');

let cardSeq = 0;
function makeCard(props) {
  cardSeq += 1;
  return { id: `c${cardSeq}`, ...props };
}

function shuffle(arr) {
  // Fisher–Yates
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/*
 * A Game holds the authoritative state for one room of players.
 * The server is the single source of truth; clients only render snapshots.
 */
class Game {
  constructor(playerList, mode, expansions) {
    // playerList: [{ id, name, isBot? }]; mode: 'original' | 'party'
    this.mode = MODES[mode] ? mode : 'original';
    this.expansions = cleanExpansions(expansions); // e.g. ['imploding','zombie']
    this.hasExp = (k) => this.expansions.includes(k);
    // deck composition depends on the mode AND player count (Party Pack scales)
    this.cfg = resolveDeck(this.mode, playerList.length);
    this.players = playerList.map((p) => ({
      id: p.id,
      name: p.name,
      isBot: !!p.isBot,
      botControlled: false, // a human seat temporarily driven by the AI (left/disconnected)
      hand: [],
      alive: true,
    }));
    this.botMemory = {}; // botId -> { topCardId, topType } from a recent peek
    this.deck = [];
    this.discard = [];
    // first turn is random, not always the game's creator
    this.turnIndex = Math.floor(Math.random() * this.players.length);
    this.turnsRemaining = 1; // how many draws current player still owes (Attack stacks this)
    this.turnsFromAttack = false; // are the current player's turns imposed by an Attack?
    this.direction = 1;        // turn order direction (flipped by Reverse)
    this.deadOrder = [];       // ids in death order, for Zombie resurrection
    this.recycleCount = 0;     // times the draw pile has been recycled (endgame escalation)
    this.phase = 'playing'; // 'playing' | 'finished'
    this.winnerId = null;
    this.log = [];
    // pending action awaiting a Nope window, or a sub-decision (favor/defuse/future)
    this.pending = null;
    this.transferSeq = 0;     // increments on each card stolen/given
    this.lastTransfer = null; // { seq, card, fromId, toId, fromName, toName }
    this.lastDiscardBy = null; // id of whoever most recently sent a card to the discard
    this.shuffleSeq = 0;       // increments each time the draw pile is shuffled in play
    this.turnPeeked = false;   // did the current turn's player look at the future?
    this.suspectTopId = null;  // top card id a player peeked-then-dodged (likely a kitten)
    this.defuseWary = 0;       // draws of elevated caution after a kitten was defused back in
    this.deal();
    this.logMsg(`${this.currentPlayer().name} goes first!`);
  }

  // ---------- setup ----------

  buildBaseDeck() {
    const cards = [];
    const cfg = this.cfg;

    // Action cards (Exploding Kittens and Defuse are seeded separately in deal()).
    for (const key of Object.keys(cfg.actions)) {
      const def = CARD_DEFS[key];
      for (let i = 0; i < cfg.actions[key]; i += 1) {
        cards.push(makeCard({ type: def.type, name: def.name, blurb: def.blurb }));
      }
    }

    // Collectible cat cards (no standalone power; played as pairs/trios).
    for (const cat of catList()) {
      for (let i = 0; i < cfg.catCount; i += 1) {
        cards.push(makeCard({ type: 'CAT', cat: cat.id, name: cat.name, blurb: cat.blurb }));
      }
    }

    // Feral Cats: wild cards usable as any cat in a combo (Party Pack).
    for (let i = 0; i < (cfg.feral || 0); i += 1) {
      const def = CARD_DEFS.FERAL;
      cards.push(makeCard({ type: def.type, name: def.name, blurb: def.blurb }));
    }

    // Expansion cards mixed into the draw pile (Reverse, Mark, Swap, Streaking
    // Kitten, Zombie Kitten). Skip any type already present from the base deck.
    const present = new Set(cards.map((c) => c.type));
    for (const key of this.expansions) {
      const exp = EXPANSIONS[key];
      const adds = { ...(exp.actions || {}) };
      if (exp.special && exp.special.streak) adds.STREAK = exp.special.streak;
      if (exp.special && exp.special.zombie) adds.ZOMBIE = exp.special.zombie;
      for (const type of Object.keys(adds)) {
        if (present.has(type)) continue; // don't double-add an existing type
        const def = CARD_DEFS[type];
        for (let i = 0; i < adds[type]; i += 1) {
          cards.push(makeCard({ type: def.type, name: def.name, blurb: def.blurb }));
        }
      }
    }

    return cards;
  }

  deal() {
    const n = this.players.length;
    let deck = this.buildBaseDeck();

    // Pull Defuse cards out of the supply; deal/sprinkle them per the rules.
    const defusePool = [];
    for (let i = 0; i < this.cfg.defuse; i += 1) {
      defusePool.push(
        makeCard({ type: 'DEFUSE', name: CARD_DEFS.DEFUSE.name, blurb: CARD_DEFS.DEFUSE.blurb })
      );
    }

    shuffle(deck);

    // Deal 4 cards (no Exploding Cats yet) + 1 Catnip each = 5 cards to start.
    for (const player of this.players) {
      player.hand = deck.splice(0, 4);
      player.hand.push(defusePool.pop());
    }

    // Remaining defuses go back into the deck.
    while (defusePool.length) deck.push(defusePool.pop());

    // Insert (players - 1) Exploding Cats so exactly one player can survive,
    // capped by how many the box actually ships.
    const kittens = Math.min(n - 1, this.cfg.explodePool);
    for (let i = 0; i < kittens; i += 1) {
      deck.push(
        makeCard({ type: 'EXPLODE', name: CARD_DEFS.EXPLODE.name, blurb: CARD_DEFS.EXPLODE.blurb })
      );
    }

    // Imploding Kitten: one un-defusable kitten, starts face-down.
    if (this.hasExp('imploding')) {
      deck.push(makeCard({ type: 'IMPLODE', name: CARD_DEFS.IMPLODE.name, blurb: CARD_DEFS.IMPLODE.blurb, revealed: false }));
    }

    shuffle(deck);
    this.deck = deck;
    this.logMsg('The cats have been dealt. Good luck.');
  }

  // ---------- helpers ----------

  // Mint a fresh card of a given type (used e.g. to arm a resurrected player).
  makeOne(type) {
    const def = CARD_DEFS[type];
    return makeCard({ type: def.type, name: def.name, blurb: def.blurb });
  }

  logMsg(text) {
    this.log.push({ t: Date.now(), text });
    if (this.log.length > 80) this.log.shift();
  }

  playerById(id) {
    return this.players.find((p) => p.id === id);
  }

  alivePlayers() {
    return this.players.filter((p) => p.alive);
  }

  currentPlayer() {
    return this.players[this.turnIndex];
  }

  isCurrent(playerId) {
    return this.currentPlayer() && this.currentPlayer().id === playerId && this.phase === 'playing';
  }

  removeCardFromHand(player, cardId) {
    const idx = player.hand.findIndex((c) => c.id === cardId);
    if (idx === -1) return null;
    return player.hand.splice(idx, 1)[0];
  }

  advanceTurn() {
    this.turnPeeked = false; // peek knowledge doesn't carry into the next turn
    // Move to the next alive player and reset their owed turns.
    this.turnsRemaining -= 1;
    if (this.turnsRemaining > 0) {
      // Same player owes another turn (from an Attack stacked onto them).
      this.logMsg(`${this.currentPlayer().name} still owes ${this.turnsRemaining} more turn(s).`);
      return;
    }
    this.nextAlive(this.direction);
    this.turnsRemaining = 1;
    this.turnsFromAttack = false; // a fresh normal turn for the next player
  }

  nextAlive(step) {
    if (this.alivePlayers().length <= 1) return;
    let i = this.turnIndex;
    do {
      i = (i + step + this.players.length) % this.players.length;
    } while (!this.players[i].alive);
    this.turnIndex = i;
  }

  checkWin() {
    const alive = this.alivePlayers();
    if (alive.length <= 1 && this.phase === 'playing') {
      this.phase = 'finished';
      this.winnerId = alive[0] ? alive[0].id : null;
      this.pending = null;
      if (this.winnerId) {
        this.logMsg(`🏆 ${alive[0].name} is the last cat standing!`);
      }
    }
  }

  // ---------- per-player view (hides other hands & the deck order) ----------

  // Kittens a given player should believe could be on top of the draw pile:
  // the ones actually in the deck, plus live Exploding Kittens hidden in OTHER
  // players' hands (via a Streaking Kitten) that this viewer can't see and so
  // would assume are still in the deck. The streaking holder sees their own and
  // so doesn't double-count it.
  kittensLeftFor(playerId) {
    const inDeck = this.deck.filter(
      (c) => c.type === 'EXPLODE' || (c.type === 'IMPLODE' && c.revealed)
    ).length;
    let hiddenInOtherHands = 0;
    for (const p of this.players) {
      if (p.id === playerId) continue;
      hiddenInOtherHands += p.hand.filter((c) => c.type === 'EXPLODE').length;
    }
    return inDeck + hiddenInOtherHands;
  }

  snapshotFor(playerId) {
    const me = this.playerById(playerId);
    return {
      phase: this.phase,
      mode: this.mode,
      expansions: this.expansions,
      winnerId: this.winnerId,
      deckCount: this.deck.length,
      // Odds bar: chance the next deck card is fatal, from THIS player's vantage.
      // It's the kittens genuinely in the deck (Exploding + any face-up Imploding)
      // PLUS any live kitten a Streaking Kitten is hiding in someone else's hand —
      // the viewer can't see those, so to them they might still be in the deck.
      // The player streaking the kitten sees their own and so counts it out.
      kittensLeft: this.kittensLeftFor(playerId),
      discardTop: this.discard.length ? this.discard[this.discard.length - 1] : null,
      discardCount: this.discard.length,
      turnPlayerId: this.currentPlayer() ? this.currentPlayer().id : null,
      turnsRemaining: this.turnsRemaining,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        isBot: p.isBot || p.botControlled,
        alive: p.alive,
        handCount: p.hand.length,
        // Mark (Streaking Kittens) flips cards face-up for everyone to see.
        marked: p.hand.filter((c) => c.marked).map((c) => ({ type: c.type, name: c.name, cat: c.cat })),
        // Streaking a live Exploding Kitten is announced publicly when it happens.
        streaking: p.hand.some((c) => c.type === 'EXPLODE'),
      })),
      hand: me ? me.hand : [],
      pending: this.publicPending(playerId),
      transfer: this.transferFor(playerId),
      lastDiscardBy: this.lastDiscardBy,
      shuffleSeq: this.shuffleSeq,
      log: this.log.slice(-30),
    };
  }

  // The most recent card-take, shown only to the two players involved.
  transferFor(playerId) {
    const t = this.lastTransfer;
    if (!t || (t.fromId !== playerId && t.toId !== playerId)) return null;
    return {
      seq: t.seq,
      card: t.card,
      fromName: t.fromName,
      toName: t.toName,
      youGained: t.toId === playerId,
    };
  }

  publicPending(playerId) {
    if (!this.pending) return null;
    const p = this.pending;
    const base = {
      kind: p.kind,
      actorId: p.actorId,
      actorName: this.playerById(p.actorId) ? this.playerById(p.actorId).name : '',
      seq: p.seq || 0,
      nopeCount: p.nopes ? p.nopes.length : 0,
      noped: p.nopes ? p.nopes.length % 2 === 1 : false,
      // whoever made the most recent play in this chain — they can't Nope it
      lastActorId: p.nopes && p.nopes.length ? p.nopes[p.nopes.length - 1] : p.actorId,
      endsAt: p.endsAt || null,
      description: p.description || '',
    };
    // Private reveals: only the relevant player sees the secret payload.
    if (p.kind === 'future' && p.viewerId === playerId) {
      base.futureCards = p.futureCards;
    }
    if (p.kind === 'alter' && p.viewerId === playerId) {
      base.futureCards = p.futureCards; // top-first; this player gets to reorder them
      base.youAlter = true;
    }
    if (p.kind === 'favorPick' && p.targetId === playerId) {
      base.youMustGive = true;
    }
    if (p.kind === 'defuse' && p.actorId === playerId) {
      base.youMustPlace = true;
      base.maxIndex = this.deck.length;
    }
    if (p.kind === 'implodePlace' && p.actorId === playerId) {
      base.youPlaceImplode = true;
      base.maxIndex = this.deck.length;
    }
    if (p.kind === 'drawn' && p.actorId === playerId) {
      base.youDrew = p.card; // only the drawer sees what they drew
    }
    if (p.kind === 'explode') {
      base.explodeCard = p.explodeCard; // public — everyone sees the drawn Exploding Cat
      base.hasDefuse = p.hasDefuse;
      if (p.actorId === playerId) base.youExploded = true;
    }
    if (p.kind === 'implode') {
      base.explodeCard = p.explodeCard; // the face-up Imploding Kitten
    }
    if (p.kind === 'stealPick') {
      const target = this.playerById(p.targetId);
      base.targetName = target ? target.name : '';
      base.stealCount = target ? target.hand.length : 0; // face-down cards to pick from
      if (p.actorId === playerId) base.youSteal = true;
    }
    if (p.kind === 'stealPick' && p.targetId === playerId && p.mode === 'named') {
      // target doesn't choose for named steal; nothing extra
    }
    return base;
  }
}

module.exports = { Game, shuffle };
