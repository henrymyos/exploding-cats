'use strict';

const { ACTION_CARDS, CAT_CARD_COUNT, catList } = require('./cards');

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
  constructor(playerList) {
    // playerList: [{ id, name, isBot? }]
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
    this.phase = 'playing'; // 'playing' | 'finished'
    this.winnerId = null;
    this.log = [];
    // pending action awaiting a Nope window, or a sub-decision (favor/defuse/future)
    this.pending = null;
    this.transferSeq = 0;     // increments on each card stolen/given
    this.lastTransfer = null; // { seq, card, fromId, toId, fromName, toName }
    this.lastDiscardBy = null; // id of whoever most recently sent a card to the discard
    this.shuffleSeq = 0;       // increments each time the draw pile is shuffled in play
    this.deal();
    this.logMsg(`${this.currentPlayer().name} goes first!`);
  }

  // ---------- setup ----------

  buildBaseDeck() {
    const cards = [];

    // Action cards (everything except Exploding Cats and Catnip/Defuse, which are handled specially).
    for (const key of ['NOPE', 'ATTACK', 'SKIP', 'FAVOR', 'SHUFFLE', 'FUTURE']) {
      const def = ACTION_CARDS[key];
      for (let i = 0; i < def.count; i += 1) {
        cards.push(makeCard({ type: def.type, name: def.name, blurb: def.blurb }));
      }
    }

    // Collectible cat cards (no standalone power; played as pairs/trios).
    for (const cat of catList()) {
      for (let i = 0; i < CAT_CARD_COUNT; i += 1) {
        cards.push(
          makeCard({ type: 'CAT', cat: cat.id, name: cat.name, blurb: cat.blurb })
        );
      }
    }

    return cards;
  }

  deal() {
    const n = this.players.length;
    let deck = this.buildBaseDeck();

    // Pull Defuse cards out of the supply; deal/sprinkle them per the rules.
    const defusePool = [];
    for (let i = 0; i < ACTION_CARDS.DEFUSE.count; i += 1) {
      defusePool.push(
        makeCard({ type: 'DEFUSE', name: ACTION_CARDS.DEFUSE.name, blurb: ACTION_CARDS.DEFUSE.blurb })
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

    // Insert (players - 1) Exploding Cats so exactly one player can survive.
    for (let i = 0; i < n - 1; i += 1) {
      deck.push(
        makeCard({ type: 'EXPLODE', name: ACTION_CARDS.EXPLODE.name, blurb: ACTION_CARDS.EXPLODE.blurb })
      );
    }

    shuffle(deck);
    this.deck = deck;
    this.logMsg('The cats have been dealt. Good luck.');
  }

  // ---------- helpers ----------

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
    // Move to the next alive player and reset their owed turns.
    this.turnsRemaining -= 1;
    if (this.turnsRemaining > 0) {
      // Same player owes another turn (from an Attack stacked onto them).
      this.logMsg(`${this.currentPlayer().name} still owes ${this.turnsRemaining} more turn(s).`);
      return;
    }
    this.nextAlive(1);
    this.turnsRemaining = 1;
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

  snapshotFor(playerId) {
    const me = this.playerById(playerId);
    return {
      phase: this.phase,
      winnerId: this.winnerId,
      deckCount: this.deck.length,
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
    if (p.kind === 'favorPick' && p.targetId === playerId) {
      base.youMustGive = true;
    }
    if (p.kind === 'defuse' && p.actorId === playerId) {
      base.youMustPlace = true;
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
