'use strict';

/*
 * Cat Bluff — Liar's Dice for the family table.
 *
 * Everyone starts with five dice and rolls in secret. Players take turns
 * raising a bid ("four 3s" = at least four dice on the whole table show a 3;
 * 1s are wild and count as every face). Instead of raising, a player can call
 * the last bid a bluff: every die is revealed, and whoever was wrong loses a
 * die. Run out of dice and you're out. Last cat with dice wins.
 *
 * Same contract as the card Game so RoomManager / the client can treat both
 * alike: players[] with alive/isBot/botControlled, phase 'playing'|'finished',
 * winnerId, deadOrder, pending {kind, endsAt}, playerById/currentPlayer,
 * snapshotFor(playerId), buildRecap().
 */

const START_DICE = 5;
const REVEAL_MS = 8000;     // how long the reveal stays up before the next round auto-starts

function rollDie() { return 1 + Math.floor(Math.random() * 6); }

class BluffGame {
  constructor(playerList) {
    this.kind = 'bluff';
    this.players = playerList.map((p) => ({
      id: p.id,
      name: p.name,
      isBot: !!p.isBot,
      botControlled: false,
      alive: true,
      dice: [],
      hand: [],          // unused; keeps helpers written for the card game safe
    }));
    this.phase = 'playing';
    this.winnerId = null;
    this.deadOrder = [];
    this.round = 0;
    this.turnIndex = Math.floor(Math.random() * this.players.length);
    this.bid = null;      // { qty, face, playerId }
    this.pending = null;  // { kind: 'reveal', endsAt }
    this.reveal = null;   // last showdown, kept while pending
    this.log = [];
    for (const p of this.players) p.dice = Array.from({ length: START_DICE }, rollDie);
    this.startRound(this.players[this.turnIndex].id, true);
  }

  // ---------- helpers ----------
  playerById(id) { return this.players.find((p) => p.id === id) || null; }
  alivePlayers() { return this.players.filter((p) => p.alive); }
  currentPlayer() { return this.players[this.turnIndex] || null; }
  totalDice() { return this.players.reduce((s, p) => s + p.dice.length, 0); }
  addLog(text) {
    this.log.push({ t: Date.now(), text });
    if (this.log.length > 80) this.log.shift();
  }
  nextAliveIndex(from) {
    const n = this.players.length;
    for (let k = 1; k <= n; k += 1) {
      const i = (from + k) % n;
      if (this.players[i].alive) return i;
    }
    return from;
  }
  // How many dice on the table count for a face (1s are wild unless the bid is on 1s).
  countFace(face) {
    let n = 0;
    for (const p of this.players) for (const d of p.dice) if (d === face || (face !== 1 && d === 1)) n += 1;
    return n;
  }
  bidBeats(qty, face, prev) {
    if (!prev) return true;
    return qty > prev.qty || (qty === prev.qty && face > prev.face);
  }

  // ---------- rounds ----------
  startRound(starterId, first = false) {
    this.round += 1;
    if (!first) for (const p of this.players) p.dice = p.dice.map(() => rollDie());
    this.bid = null;
    this.pending = null;
    this.reveal = null;
    const idx = this.players.findIndex((p) => p.id === starterId && p.alive);
    this.turnIndex = idx >= 0 ? idx : this.nextAliveIndex(this.turnIndex);
    const starter = this.currentPlayer();
    this.addLog(`Round ${this.round} — ${this.totalDice()} dice on the table. ${starter ? starter.name : 'Someone'} opens the bidding.`);
  }

  // ---------- moves ----------
  placeBid(playerId, qty, face) {
    if (this.phase !== 'playing') return { ok: false, error: 'Game is over.' };
    if (this.pending) return { ok: false, error: 'Wait for the reveal.' };
    const p = this.currentPlayer();
    if (!p || p.id !== playerId) return { ok: false, error: 'Not your turn.' };
    qty = Math.floor(Number(qty)); face = Math.floor(Number(face));
    if (!(face >= 1 && face <= 6)) return { ok: false, error: 'Pick a face 1–6.' };
    if (!(qty >= 1)) return { ok: false, error: 'Bid at least one die.' };
    if (qty > this.totalDice()) return { ok: false, error: `Only ${this.totalDice()} dice on the table.` };
    if (!this.bidBeats(qty, face, this.bid)) return { ok: false, error: 'Bid must be higher than the last one.' };
    this.bid = { qty, face, playerId };
    this.addLog(`${p.name} bids ${qty} × ${face}${face === 1 ? ' (1s, no wilds)' : ''}.`);
    this.turnIndex = this.nextAliveIndex(this.turnIndex);
    return { ok: true };
  }

  callBluff(playerId) {
    if (this.phase !== 'playing') return { ok: false, error: 'Game is over.' };
    if (this.pending) return { ok: false, error: 'Wait for the reveal.' };
    const caller = this.currentPlayer();
    if (!caller || caller.id !== playerId) return { ok: false, error: 'Not your turn.' };
    if (!this.bid) return { ok: false, error: 'Nothing to call yet — make the first bid.' };
    const bid = this.bid;
    const bidder = this.playerById(bid.playerId);
    const actual = this.countFace(bid.face);
    const bidHeld = actual >= bid.qty;
    const loser = bidHeld ? caller : bidder;
    const dice = {};
    for (const p of this.players) dice[p.id] = p.dice.slice();
    loser.dice.pop();
    let eliminated = false;
    if (loser.dice.length === 0) {
      loser.alive = false;
      this.deadOrder.push(loser.id);
      eliminated = true;
    }
    this.reveal = {
      callerId: caller.id, callerName: caller.name,
      bidderId: bidder.id, bidderName: bidder.name,
      bid: { qty: bid.qty, face: bid.face },
      actual, bidHeld,
      loserId: loser.id, loserName: loser.name, eliminated,
      dice,
    };
    this.addLog(`${caller.name} calls bluff on ${bidder.name}'s ${bid.qty} × ${bid.face}: there were ${actual}. ${loser.name} loses a die${eliminated ? ' and is out' : ''}.`);
    this.pending = { kind: 'reveal', endsAt: Date.now() + REVEAL_MS };
    return { ok: true };
  }

  // Anyone still in the room can tap through the reveal; the timer does it otherwise.
  continueReveal(playerId) {
    if (!this.pending || this.pending.kind !== 'reveal') return { ok: false, error: 'Nothing to continue.' };
    if (!this.playerById(playerId)) return { ok: false, error: 'Not in this game.' };
    this.finishReveal();
    return { ok: true };
  }

  finishReveal() {
    if (!this.pending || this.pending.kind !== 'reveal') return;
    const r = this.reveal;
    const alive = this.alivePlayers();
    if (alive.length <= 1) {
      this.pending = null;
      this.phase = 'finished';
      this.winnerId = alive[0] ? alive[0].id : null;
      if (this.winnerId) this.addLog(`${alive[0].name} is the last cat with dice — winner!`);
      return;
    }
    // The loser opens the next round; if they're out, the next seat after them does.
    const loserIdx = this.players.findIndex((p) => p.id === r.loserId);
    const starterIdx = this.players[loserIdx].alive ? loserIdx : this.nextAliveIndex(loserIdx);
    this.startRound(this.players[starterIdx].id);
  }

  // ---------- views ----------
  buildRecap() {
    const place = {};
    let rank = 1;
    if (this.winnerId) place[this.winnerId] = rank++;
    for (let i = this.deadOrder.length - 1; i >= 0; i -= 1) {
      if (place[this.deadOrder[i]] == null) place[this.deadOrder[i]] = rank++;
    }
    for (const p of this.players) if (place[p.id] == null) place[p.id] = rank++;
    const standings = this.players.map((p) => ({
      id: p.id, name: p.name, isBot: p.isBot || p.botControlled, place: place[p.id],
    })).sort((a, b) => a.place - b.place);
    return { standings };
  }

  snapshotFor(playerId) {
    const revealing = !!(this.pending && this.pending.kind === 'reveal');
    const bidder = this.bid ? this.playerById(this.bid.playerId) : null;
    return {
      kind: 'bluff',
      phase: this.phase,
      winnerId: this.winnerId,
      round: this.round,
      totalDice: this.totalDice(),
      turnPlayerId: this.currentPlayer() ? this.currentPlayer().id : null,
      bid: this.bid ? { qty: this.bid.qty, face: this.bid.face, playerId: this.bid.playerId, name: bidder ? bidder.name : '' } : null,
      pending: this.pending ? { kind: this.pending.kind, endsAt: this.pending.endsAt } : null,
      reveal: revealing ? this.reveal : null,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, isBot: p.isBot, botControlled: p.botControlled, alive: p.alive,
        diceCount: p.dice.length,
        dice: p.id === playerId || revealing ? p.dice.slice() : null,
      })),
      myDice: (this.playerById(playerId) || { dice: [] }).dice.slice(),
      log: this.log.slice(-40),
      recap: this.phase === 'finished' ? this.buildRecap() : null,
    };
  }
}

module.exports = { BluffGame, START_DICE, REVEAL_MS };
