'use strict';

/*
 * Stray Cats — a hidden-role game (Werewolf-style) for 4–10 players.
 *
 * A few players are secretly Strays; everyone else is a House Cat, and one
 * House Cat is the Vet. Play alternates:
 *   Night — the Strays secretly agree on a cat to chase off; the Vet secretly
 *           checks one cat's collar (learns Stray or House Cat). The first
 *           night is quiet: the Strays only meet, nobody is chased off.
 *   Day   — everyone argues at the table and votes to send one cat outside.
 *           The most votes goes (ties or "skip" majority: nobody). Their role
 *           is revealed.
 * The House wins when every Stray is out. The Strays win when they equal or
 * outnumber everyone else.
 *
 * Same contract as the card Game / BluffGame so RoomManager and the client can
 * treat all three alike: players[] with alive/isBot/botControlled, phase
 * 'playing'|'finished', winnerId, deadOrder, pending {kind, endsAt},
 * playerById/currentPlayer, snapshotFor(playerId), buildRecap(), onTimer().
 */

const NIGHT_MS = 45000;
const DAY_MS = 90000;
const REVEAL_MS = 7000;
const MIN_PLAYERS = 4;

function strayCount(n) { return n >= 8 ? 2 : 1; }
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

class StraysGame {
  constructor(playerList) {
    this.kind = 'strays';
    this.players = playerList.map((p) => ({
      id: p.id,
      name: p.name,
      isBot: !!p.isBot,
      botControlled: false,
      alive: true,
      role: 'house',   // 'stray' | 'vet' | 'house'
      hand: [],        // unused; keeps helpers written for the card game safe
      dice: [],
    }));
    const order = shuffle(this.players.map((p) => p.id));
    const nStrays = strayCount(this.players.length);
    order.slice(0, nStrays).forEach((id) => { this.playerById(id).role = 'stray'; });
    this.playerById(order[nStrays]).role = 'vet';
    this.phase = 'playing';
    this.winnerId = null;
    this.winnerTeam = null;   // 'house' | 'strays'
    this.deadOrder = [];
    this.round = 0;
    this.stage = null;        // 'night' | 'day' | 'reveal'
    this.pending = null;
    this.picks = {};          // night: strayId -> targetId
    this.peeks = {};          // night: vetId -> targetId
    this.votes = {};          // day: voterId -> targetId | null (skip)
    this.vetKnowledge = {};   // targetId -> 'stray' | 'house' (Vet's private notes)
    this.reveal = null;       // last outcome, shown during the reveal stage
    this.log = [];
    this.addLog(`${this.players.length} cats, ${nStrays} of them Stray${nStrays === 1 ? '' : 's'}. Roles are dealt in secret.`);
    this.startNight();
  }

  // ---------- helpers ----------
  playerById(id) { return this.players.find((p) => p.id === id) || null; }
  alivePlayers() { return this.players.filter((p) => p.alive); }
  aliveStrays() { return this.players.filter((p) => p.alive && p.role === 'stray'); }
  aliveHouse() { return this.players.filter((p) => p.alive && p.role !== 'stray'); }
  currentPlayer() { return null; }   // no turn order; the client uses stage + acted flags
  vet() { return this.players.find((p) => p.role === 'vet') || null; }
  addLog(text) {
    this.log.push({ t: Date.now(), text });
    if (this.log.length > 80) this.log.shift();
  }
  isQuietNight() { return this.round === 1; }

  // Who still has to act in the current stage.
  waitingOn() {
    if (this.stage === 'night') {
      // Quiet first night: the Strays only meet, so only the Vet has a move.
      const ids = this.isQuietNight() ? [] : this.aliveStrays().filter((p) => !this.picks[p.id]).map((p) => p.id);
      const v = this.vet();
      if (v && v.alive && !this.peeks[v.id]) ids.push(v.id);
      return ids;
    }
    if (this.stage === 'day') return this.alivePlayers().filter((p) => !(p.id in this.votes)).map((p) => p.id);
    return [];
  }

  // ---------- stages ----------
  startNight() {
    this.round += 1;
    this.stage = 'night';
    this.picks = {}; this.peeks = {}; this.votes = {};
    this.reveal = null;
    this.pending = { kind: 'night', endsAt: Date.now() + NIGHT_MS };
    this.addLog(this.isQuietNight()
      ? `Night ${this.round} — a quiet night. The Strays meet; the Vet checks a collar.`
      : `Night ${this.round} — the Strays are prowling.`);
  }

  startDay() {
    this.stage = 'day';
    this.votes = {};
    this.reveal = null;
    this.pending = { kind: 'day', endsAt: Date.now() + DAY_MS };
    this.addLog(`Day ${this.round} — ${this.alivePlayers().length} cats left, ${this.aliveStrays().length} Stray${this.aliveStrays().length === 1 ? '' : 's'} hiding. Vote!`);
  }

  startReveal(reveal) {
    this.stage = 'reveal';
    this.reveal = reveal;
    this.pending = { kind: 'reveal', endsAt: Date.now() + REVEAL_MS };
  }

  // ---------- moves ----------
  pick(playerId, targetId) {
    if (this.phase !== 'playing') return { ok: false, error: 'Game is over.' };
    if (this.stage !== 'night') return { ok: false, error: 'The Strays only act at night.' };
    const p = this.playerById(playerId);
    if (!p || !p.alive || p.role !== 'stray') return { ok: false, error: 'Only a living Stray can do that.' };
    if (this.isQuietNight()) return { ok: false, error: 'The first night is quiet — nobody is chased off.' };
    const t = this.playerById(targetId);
    if (!t || !t.alive || t.role === 'stray') return { ok: false, error: 'Pick a living cat that isn\'t a Stray.' };
    this.picks[playerId] = targetId;
    this.maybeResolveNight();
    return { ok: true };
  }

  peek(playerId, targetId) {
    if (this.phase !== 'playing') return { ok: false, error: 'Game is over.' };
    if (this.stage !== 'night') return { ok: false, error: 'The Vet only checks collars at night.' };
    const p = this.playerById(playerId);
    if (!p || !p.alive || p.role !== 'vet') return { ok: false, error: 'Only the Vet can do that.' };
    if (this.peeks[playerId]) return { ok: false, error: 'You already checked a collar tonight.' };
    const t = this.playerById(targetId);
    if (!t || !t.alive || t.id === playerId) return { ok: false, error: 'Pick another living cat.' };
    this.peeks[playerId] = targetId;
    this.vetKnowledge[targetId] = t.role === 'stray' ? 'stray' : 'house';
    this.maybeResolveNight();
    return { ok: true };
  }

  vote(playerId, targetId) {
    if (this.phase !== 'playing') return { ok: false, error: 'Game is over.' };
    if (this.stage !== 'day') return { ok: false, error: 'Voting happens during the day.' };
    const p = this.playerById(playerId);
    if (!p || !p.alive) return { ok: false, error: 'Only living cats vote.' };
    if (targetId != null) {
      const t = this.playerById(targetId);
      if (!t || !t.alive || t.id === playerId) return { ok: false, error: 'Vote for another living cat, or skip.' };
    }
    this.votes[playerId] = targetId == null ? null : targetId;
    this.maybeResolveDay();
    return { ok: true };
  }

  // Anyone in the game can tap through the reveal; the timer does it otherwise.
  continueReveal(playerId) {
    if (!this.pending || this.pending.kind !== 'reveal') return { ok: false, error: 'Nothing to continue.' };
    if (!this.playerById(playerId)) return { ok: false, error: 'Not in this game.' };
    this.finishReveal();
    return { ok: true };
  }

  // Timer for the current stage ran out.
  onTimer() {
    if (this.phase !== 'playing' || !this.pending) return;
    if (this.stage === 'night') this.resolveNight();
    else if (this.stage === 'day') this.resolveDay();
    else if (this.stage === 'reveal') this.finishReveal();
  }

  // ---------- resolution ----------
  maybeResolveNight() {
    if (this.waitingOn().length === 0) this.resolveNight();
  }
  maybeResolveDay() {
    if (this.waitingOn().length === 0) this.resolveDay();
  }

  resolveNight() {
    if (this.stage !== 'night') return;
    // Strays who never picked lean on a teammate's pick; otherwise a random cat.
    let victim = null;
    if (!this.isQuietNight()) {
      const tally = {};
      for (const id of Object.values(this.picks)) tally[id] = (tally[id] || 0) + 1;
      const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
      if (ranked.length) {
        const top = ranked.filter((r) => r[1] === ranked[0][1]).map((r) => r[0]);
        victim = this.playerById(pickRandom(top));
      } else if (this.aliveStrays().length) {
        victim = pickRandom(this.aliveHouse());
      }
    }
    // The Vet always learns something: an unpicked check falls on a random cat.
    const v = this.vet();
    if (v && v.alive && !this.peeks[v.id]) {
      const options = this.alivePlayers().filter((p) => p.id !== v.id && !(p.id in this.vetKnowledge));
      const t = options.length ? pickRandom(options) : null;
      if (t) { this.peeks[v.id] = t.id; this.vetKnowledge[t.id] = t.role === 'stray' ? 'stray' : 'house'; }
    }
    if (victim) {
      victim.alive = false;
      this.deadOrder.push(victim.id);
      this.addLog(`Morning: ${victim.name} was chased off in the night — a ${victim.role === 'stray' ? 'Stray' : 'House Cat'}${victim.role === 'vet' ? ' (the Vet!)' : ''}.`);
    } else {
      this.addLog(this.isQuietNight() ? 'Morning: everyone is still here. The hunt begins tonight.' : 'Morning: nobody was chased off.');
    }
    this.startReveal({
      kind: 'night', round: this.round, quiet: this.isQuietNight(),
      victimId: victim ? victim.id : null, victimName: victim ? victim.name : null,
      victimRole: victim ? victim.role : null,
    });
    this.checkWin();
  }

  resolveDay() {
    if (this.stage !== 'day') return;
    const tally = {};
    let skips = 0;
    for (const p of this.alivePlayers()) {
      const v = this.votes[p.id];
      if (v === undefined || v === null) skips += 1;   // no vote counts as a skip
      else tally[v] = (tally[v] || 0) + 1;
    }
    const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    let out = null;
    if (ranked.length && ranked[0][1] > skips && (ranked.length === 1 || ranked[0][1] > ranked[1][1])) {
      out = this.playerById(ranked[0][0]);
    }
    if (out) {
      out.alive = false;
      this.deadOrder.push(out.id);
      this.addLog(`The table sent ${out.name} outside — ${out.role === 'stray' ? 'a Stray!' : 'a House Cat' + (out.role === 'vet' ? ' (the Vet!)' : '')}.`);
    } else {
      this.addLog('The vote was split — nobody was sent outside.');
    }
    this.startReveal({
      kind: 'day', round: this.round,
      outId: out ? out.id : null, outName: out ? out.name : null, outRole: out ? out.role : null,
      tally, skips,
    });
    this.checkWin();
  }

  finishReveal() {
    if (!this.pending || this.pending.kind !== 'reveal') return;
    if (this.phase === 'finished') { this.pending = null; return; }
    if (this.reveal && this.reveal.kind === 'night') this.startDay();
    else this.startNight();
  }

  checkWin() {
    const strays = this.aliveStrays().length;
    const house = this.aliveHouse().length;
    let team = null;
    if (strays === 0) team = 'house';
    else if (strays >= house) team = 'strays';
    if (!team) return;
    this.phase = 'finished';
    this.winnerTeam = team;
    const winners = this.players.filter((p) => (team === 'strays') === (p.role === 'stray'));
    const alive = winners.find((p) => p.alive) || winners[0];
    this.winnerId = alive ? alive.id : null;
    this.addLog(team === 'house' ? 'Every Stray is gone — the House Cats win!' : 'The Strays have the run of the house — the Strays win!');
    // Keep the reveal up so everyone sees the final outcome, then the victory screen.
    this.pending = { kind: 'reveal', endsAt: Date.now() + REVEAL_MS };
  }

  // ---------- views ----------
  buildRecap() {
    const team = this.winnerTeam;
    const standings = this.players.map((p) => ({
      id: p.id, name: p.name, isBot: p.isBot || p.botControlled,
      place: team ? ((team === 'strays') === (p.role === 'stray') ? 1 : 2) : 2,
      role: p.role,
    })).sort((a, b) => a.place - b.place);
    return { standings };
  }

  snapshotFor(playerId) {
    const me = this.playerById(playerId);
    const myRole = me ? me.role : null;
    const revealing = this.stage === 'reveal';
    const over = this.phase === 'finished';
    const waiting = new Set(this.waitingOn());
    const roleVisible = (p) => !p.alive || over || (myRole === 'stray' && p.role === 'stray') || p.id === playerId;
    const tally = {};
    if (this.stage === 'day') for (const v of Object.values(this.votes)) if (v) tally[v] = (tally[v] || 0) + 1;
    return {
      kind: 'strays',
      phase: this.phase,
      winnerId: this.winnerId,
      winnerTeam: this.winnerTeam,
      victoryTitle: this.winnerTeam ? (this.winnerTeam === 'house' ? 'House Cats win!' : 'Strays win!') : null,
      victorySub: this.winnerTeam ? (this.winnerTeam === 'house' ? 'every Stray was found' : 'the Strays took over the house') : null,
      youWon: !!(me && this.winnerTeam && ((this.winnerTeam === 'strays') === (me.role === 'stray'))),
      round: this.round,
      stage: this.stage,
      quietNight: this.stage === 'night' && this.isQuietNight(),
      straysAlive: this.aliveStrays().length,
      pending: this.pending ? { kind: this.pending.kind, endsAt: this.pending.endsAt } : null,
      reveal: revealing || over ? this.reveal : null,
      myRole,
      myPick: myRole === 'stray' ? this.picks[playerId] || null : null,
      myPeek: myRole === 'vet' ? this.peeks[playerId] || null : null,
      myVote: playerId in this.votes ? this.votes[playerId] : undefined,
      vetKnowledge: myRole === 'vet' ? this.vetKnowledge : null,
      strayPicks: myRole === 'stray' ? this.picks : null,
      tally,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, isBot: p.isBot, botControlled: p.botControlled, alive: p.alive,
        role: roleVisible(p) ? p.role : null,
        acted: this.stage === 'day' ? (p.id in this.votes) : (this.stage === 'night' ? (p.alive && !waiting.has(p.id) && (p.role === 'stray' || p.role === 'vet')) : false),
        waiting: waiting.has(p.id),
        votedFor: this.stage === 'day' && p.id in this.votes ? this.votes[p.id] : undefined,
      })),
      log: this.log.slice(-40),
      recap: over ? this.buildRecap() : null,
    };
  }
}

module.exports = { StraysGame, MIN_PLAYERS, NIGHT_MS, DAY_MS, REVEAL_MS };
