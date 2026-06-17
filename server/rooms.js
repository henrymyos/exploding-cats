'use strict';

const { Game } = require('./game');
require('./actions'); // augments Game.prototype

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
const MAX_PLAYERS = 5;
const MIN_PLAYERS = 2;

function randomCode() {
  let s = '';
  for (let i = 0; i < 4; i += 1) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
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
    // Rejoin if this player was already here.
    const existing = room.players.find((p) => p.id === playerId);
    if (existing) {
      existing.connected = true;
      existing.name = name || existing.name;
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
      // Mid-game: mark disconnected but keep their seat/cards.
      const p = room.players.find((pl) => pl.id === playerId);
      if (p) p.connected = false;
    }
  }

  destroyRoom(code) {
    const room = this.getRoom(code);
    if (room && room.timer) clearTimeout(room.timer);
    this.rooms.delete((code || '').toUpperCase());
  }

  startGame(code, playerId) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Room not found.' };
    if (room.hostId !== playerId) return { error: 'Only the host can start the game.' };
    if (room.game) return { error: 'Game already started.' };
    if (room.players.length < MIN_PLAYERS) return { error: 'Need at least 2 players.' };
    room.game = new Game(room.players.map((p) => ({ id: p.id, name: p.name })));
    this.scheduleResolve(room);
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
    // A resolution can open a NEW pending (e.g. action -> favorPick); chain it.
    this.scheduleResolve(room);
    this.broadcast(room.code);
  }

  // After any successful player action that changes pending state.
  afterMutation(room) {
    this.scheduleResolve(room);
    this.broadcast(room.code);
  }
}

module.exports = { RoomManager, MAX_PLAYERS, MIN_PLAYERS };
