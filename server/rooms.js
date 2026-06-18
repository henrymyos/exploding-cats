'use strict';

const { Game } = require('./game');
const brain = require('./botBrain');
require('./actions'); // augments Game.prototype

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
const MAX_PLAYERS = 5;
const MIN_PLAYERS = 2;

const BOT_NAMES = ['Whiskers Bot', 'Mittens Bot', 'Felix Bot', 'Smokey Bot', 'Tiger Bot'];

function randomCode() {
  let s = '';
  for (let i = 0; i < 4; i += 1) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

function rand(min, max) {
  return min + Math.floor(Math.random() * (max - min));
}

// A seat the AI should drive: a real bot, or a human who left/disconnected.
function isBotSeat(p) {
  return !!(p && (p.isBot || p.botControlled));
}

/*
 * RoomManager owns all rooms and pushes state to clients via a `broadcast`
 * callback supplied by the server. It also drives the pending-action timers.
 */
class RoomManager {
  constructor(broadcast) {
    this.rooms = new Map(); // code -> room
    this.broadcast = broadcast; // (code) => void  (server re-sends snapshots)
  }

  createRoom(hostName, hostId) {
    let code = randomCode();
    while (this.rooms.has(code)) code = randomCode();
    const room = {
      code,
      hostId,
      players: [{ id: hostId, name: hostName, connected: true }],
      game: null,
      timer: null,
    };
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get((code || '').toUpperCase());
  }

  joinRoom(code, name, playerId) {
    const room = this.getRoom(code);
    if (!room) return { error: 'No room with that code.' };
    // Rejoin if this player was already here — restore human control of their seat.
    const existing = room.players.find((p) => p.id === playerId);
    if (existing) {
      existing.connected = true;
      existing.name = name || existing.name;
      if (room.game) {
        const seat = room.game.playerById(playerId);
        if (seat && !seat.isBot) seat.botControlled = false;
      }
      return { room };
    }
    if (room.game) return { error: 'That game has already started.' };
    if (room.players.length >= MAX_PLAYERS) return { error: 'Room is full (max 5).' };
    room.players.push({ id: playerId, name, connected: true });
    return { room };
  }

  leaveRoom(code, playerId) {
    const room = this.getRoom(code);
    if (!room) return;
    if (!room.game) {
      // In the lobby: drop the player entirely.
      room.players = room.players.filter((p) => p.id !== playerId);
      if (room.hostId === playerId && room.players.length) {
        room.hostId = room.players[0].id;
      }
      if (room.players.length === 0) this.destroyRoom(code);
    } else {
      // Mid-game: mark disconnected but keep their seat/cards, and let the AI
      // take over so the game doesn't stall waiting on someone who left.
      const p = room.players.find((pl) => pl.id === playerId);
      if (p) p.connected = false;
      const seat = room.game.playerById(playerId);
      if (seat && !seat.isBot) seat.botControlled = true;
    }
  }

  // A player explicitly leaves the current game (returns them to the home screen).
  // Their seat is handed to the AI so everyone else can keep playing.
  leaveGame(code, playerId) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Room not found.' };
    this.leaveRoom(code, playerId);
    return { room: this.getRoom(code) || null };
  }

  // Host ends the current game for everyone; the room drops back to the lobby.
  endGame(code, playerId) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Room not found.' };
    if (room.hostId !== playerId) return { error: 'Only the host can end the game.' };
    if (room.timer) { clearTimeout(room.timer); room.timer = null; }
    if (room.botTimer) { clearTimeout(room.botTimer); room.botTimer = null; }
    room.game = null;
    // Drop any disconnected players and all bots; keep connected humans in the lobby.
    room.players = room.players.filter((p) => p.connected && !p.isBot);
    if (!room.players.find((p) => p.id === room.hostId) && room.players.length) {
      room.hostId = room.players[0].id;
    }
    return { room };
  }

  destroyRoom(code) {
    const room = this.getRoom(code);
    if (room && room.timer) clearTimeout(room.timer);
    if (room && room.botTimer) clearTimeout(room.botTimer);
    this.rooms.delete((code || '').toUpperCase());
  }

  addBot(code, playerId) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Room not found.' };
    if (room.hostId !== playerId) return { error: 'Only the host can add bots.' };
    if (room.game) return { error: 'Game already started.' };
    if (room.players.length >= MAX_PLAYERS) return { error: 'Room is full (max 5).' };
    const used = new Set(room.players.map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `Bot ${room.players.length}`;
    const id = `bot_${randomCode()}${room.players.length}`;
    room.players.push({ id, name, connected: true, isBot: true });
    return { room };
  }

  removeBot(code, playerId, botId) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Room not found.' };
    if (room.hostId !== playerId) return { error: 'Only the host can remove bots.' };
    if (room.game) return { error: 'Game already started.' };
    // If no specific bot given, drop the last one added.
    const target = botId
      ? room.players.find((p) => p.isBot && p.id === botId)
      : [...room.players].reverse().find((p) => p.isBot);
    if (!target) return { error: 'No bot to remove.' };
    room.players = room.players.filter((p) => p.id !== target.id);
    return { room };
  }

  startGame(code, playerId) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Room not found.' };
    if (room.hostId !== playerId) return { error: 'Only the host can start the game.' };
    if (room.game) return { error: 'Game already started.' };
    if (room.players.length < MIN_PLAYERS) return { error: 'Need at least 2 players.' };
    room.game = new Game(room.players.map((p) => ({ id: p.id, name: p.name, isBot: p.isBot })));
    this.scheduleResolve(room);
    this.scheduleBots(room);
    return { room };
  }

  // ---- timer handling for pending windows ----

  scheduleResolve(room) {
    if (room.timer) {
      clearTimeout(room.timer);
      room.timer = null;
    }
    const game = room.game;
    if (!game || !game.pending || !game.pending.endsAt) return;
    const delay = Math.max(0, game.pending.endsAt - Date.now());
    room.timer = setTimeout(() => this.fireResolve(room), delay + 30);
  }

  fireResolve(room) {
    const game = room.game;
    if (!game || !game.pending) return;
    // The window may have been extended by a late Hiss; re-check the deadline.
    if (game.pending.endsAt && Date.now() < game.pending.endsAt - 10) {
      this.scheduleResolve(room);
      return;
    }
    const kind = game.pending.kind;
    if (kind === 'action') game.resolveAction();
    else if (kind === 'future') game.dismissFutureAuto();
    else if (kind === 'favorPick') game.favorAuto();
    else if (kind === 'defuse') game.defuseAuto();
    else if (kind === 'drawn') game.continueTurnAuto();
    else if (kind === 'stealPick') game.stealAuto();
    // A resolution can open a NEW pending (e.g. action -> favorPick); chain it.
    this.scheduleResolve(room);
    this.broadcast(room.code);
    this.scheduleBots(room);
  }

  // After any successful player action that changes pending state.
  afterMutation(room) {
    this.scheduleResolve(room);
    this.broadcast(room.code);
    this.scheduleBots(room);
  }

  // ---- bot driving ----

  // Look at the current state and, if a bot should act, schedule that one action.
  scheduleBots(room) {
    if (room.botTimer) {
      clearTimeout(room.botTimer);
      room.botTimer = null;
    }
    const g = room.game;
    if (!g || g.phase !== 'playing') return;
    const p = g.pending;

    if (p && p.kind === 'action') {
      // A bot may want to Hiss this action.
      const noper = g.players.find(
        (b) => isBotSeat(b) && b.alive && brain.chooseNope(g, b)
      );
      if (noper) {
        room.botTimer = setTimeout(() => this.runBotJob(room, 'nope', noper.id), rand(500, 1400));
        return;
      }
      // Nobody can/will Hiss? Don't make everyone wait out the full window.
      const humanHoldsHiss = g.players.some(
        (pl) => !isBotSeat(pl) && pl.alive && pl.hand.some((c) => c.type === 'NOPE')
      );
      if (!humanHoldsHiss && p.endsAt - Date.now() > 900) {
        p.endsAt = Date.now() + 700;
        this.scheduleResolve(room);
      }
      return;
    }

    if (p && p.kind === 'favorPick' && this.isBot(g, p.targetId)) {
      room.botTimer = setTimeout(() => this.runBotJob(room, 'favor', p.targetId), rand(700, 1400));
      return;
    }
    if (p && p.kind === 'defuse' && this.isBot(g, p.actorId)) {
      room.botTimer = setTimeout(() => this.runBotJob(room, 'defuse', p.actorId), rand(700, 1400));
      return;
    }
    if (p && p.kind === 'future' && this.isBot(g, p.viewerId)) {
      room.botTimer = setTimeout(() => this.runBotJob(room, 'future', p.viewerId), rand(900, 1600));
      return;
    }
    if (p && p.kind === 'drawn' && this.isBot(g, p.actorId)) {
      room.botTimer = setTimeout(() => this.runBotJob(room, 'continue', p.actorId), rand(500, 1000));
      return;
    }
    if (p && p.kind === 'stealPick' && this.isBot(g, p.actorId)) {
      room.botTimer = setTimeout(() => this.runBotJob(room, 'steal', p.actorId), rand(700, 1300));
      return;
    }
    if (!p) {
      const cur = g.currentPlayer();
      if (cur && isBotSeat(cur) && cur.alive) {
        room.botTimer = setTimeout(() => this.runBotJob(room, 'turn', cur.id), rand(800, 1600));
      }
    }
  }

  isBot(game, id) {
    const p = game.playerById(id);
    return !!(p && isBotSeat(p));
  }

  runBotJob(room, type, botId) {
    room.botTimer = null;
    const g = room.game;
    if (!g || g.phase !== 'playing') return;
    const bot = g.playerById(botId);
    if (!bot || !bot.alive) { this.scheduleBots(room); return; }
    const p = g.pending;

    if (type === 'nope') {
      if (p && p.kind === 'action' && brain.chooseNope(g, bot)) g.playNope(botId);
    } else if (type === 'favor') {
      if (p && p.kind === 'favorPick' && p.targetId === botId) {
        g.favorGive(botId, brain.chooseFavorCard(g, bot));
      }
    } else if (type === 'defuse') {
      if (p && p.kind === 'defuse' && p.actorId === botId) {
        g.defusePlace(botId, brain.chooseDefuseIndex(g));
      }
    } else if (type === 'future') {
      if (p && p.kind === 'future' && p.viewerId === botId) {
        const deckTop = g.deck[g.deck.length - 1];
        if (deckTop) g.botMemory[botId] = { topCardId: deckTop.id, topType: deckTop.type };
        g.dismissFuture(botId);
      }
    } else if (type === 'continue') {
      if (p && p.kind === 'drawn' && p.actorId === botId) g.continueTurn(botId);
    } else if (type === 'steal') {
      if (p && p.kind === 'stealPick' && p.actorId === botId) {
        const target = g.playerById(p.targetId);
        const n = target ? target.hand.length : 0;
        g.stealTake(botId, n ? Math.floor(Math.random() * n) : 0);
      }
    } else if (type === 'turn') {
      if (!p && g.currentPlayer() && g.currentPlayer().id === botId) {
        const action = brain.chooseTurnAction(g, bot);
        let res = { ok: true };
        if (action.kind === 'play') res = g.playCards(botId, action.cardIds, action.opts || {});
        if (action.kind === 'draw' || !res.ok) g.drawCard(botId);
      }
    }
    this.afterMutation(room);
  }
}

module.exports = { RoomManager, MAX_PLAYERS, MIN_PLAYERS };
