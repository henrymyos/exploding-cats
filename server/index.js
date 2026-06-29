'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const { RoomManager } = require('./rooms');
const { catList } = require('./cards');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

app.use(express.static(PUBLIC_DIR));

// Expose the cat roster so the client can label things without hardcoding.
app.get('/api/cats', (_req, res) => {
  res.json(catList());
});

// ------------------------------------------------------------------
// Real-time game wiring
// ------------------------------------------------------------------

// Send each player their own (hidden-info) snapshot of a room.
function broadcast(code) {
  const room = manager.getRoom(code);
  if (!room) return;
  const lobby = {
    code: room.code,
    hostId: room.hostId,
    started: !!room.game,
    mode: room.mode || 'original',
    expansions: room.expansions || [],
    creatorId: room.creatorId || room.hostId,
    players: room.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected, isBot: !!p.isBot, avatar: p.avatar || null })),
    scores: manager.scoreboard(room),
    streak: room.streak || null,
    reaction: room.reaction || null,
  };
  for (const p of room.players) {
    const payload = { lobby };
    if (room.game) payload.game = room.game.snapshotFor(p.id);
    io.to(socketForPlayer(code, p.id)).emit('state', payload);
  }
}

const manager = new RoomManager(broadcast);

// Track which socket belongs to which player in which room.
const socketIndex = new Map(); // socket.id -> { code, playerId }
// playerId -> the socket.id that currently represents them. Lets a late/stale
// disconnect (from a socket the player already replaced by reconnecting) be ignored
// so we never hand a returning player's seat back to a bot.
const playerSocket = new Map();
function socketForPlayer(code, playerId) {
  // Always target the player's CURRENT socket. (During a reconnect the old, dead
  // socket can still be in socketIndex; emitting to it would drop the update.)
  return playerSocket.get(playerId) || '__none__';
}

function ackErr(cb, error) {
  if (typeof cb === 'function') cb({ ok: false, error });
}
function ackOk(cb, data = {}) {
  if (typeof cb === 'function') cb({ ok: true, ...data });
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, playerId, avatar, mode }, cb) => {
    if (!name || !playerId) return ackErr(cb, 'Missing name.');
    const room = manager.createRoom(name.trim().slice(0, 16), playerId, avatar, mode);
    socketIndex.set(socket.id, { code: room.code, playerId });
    playerSocket.set(playerId, socket.id);
    socket.join(room.code);
    ackOk(cb, { code: room.code });
    broadcast(room.code);
  });

  socket.on('setMode', ({ code, playerId, mode }, cb) => {
    const { error } = manager.setMode(code, playerId, mode);
    if (error) return ackErr(cb, error);
    ackOk(cb);
    broadcast(code);
  });

  socket.on('setExpansion', ({ code, playerId, key, on }, cb) => {
    const { error } = manager.setExpansion(code, playerId, key, on);
    if (error) return ackErr(cb, error);
    ackOk(cb);
    broadcast(code);
  });

  socket.on('joinRoom', ({ code, name, playerId, avatar }, cb) => {
    if (!name || !playerId || !code) return ackErr(cb, 'Missing details.');
    const { room, error } = manager.joinRoom(code, name.trim().slice(0, 16), playerId, avatar);
    if (error) return ackErr(cb, error);
    socketIndex.set(socket.id, { code: room.code, playerId });
    playerSocket.set(playerId, socket.id);
    socket.join(room.code);
    ackOk(cb, { code: room.code });
    broadcast(room.code);
    // If this was a reconnect mid-game, the seat is human again now — re-evaluate
    // the bots so the AI stops driving the reclaimed seat.
    if (room.game) manager.scheduleBots(room);
  });

  socket.on('react', ({ code, playerId, emoji }, cb) => {
    manager.react(code, playerId, emoji);
    ackOk(cb);
    broadcast(code);
  });

  socket.on('addBot', ({ code, playerId }, cb) => {
    const { error } = manager.addBot(code, playerId);
    if (error) return ackErr(cb, error);
    ackOk(cb);
    broadcast(code);
  });

  socket.on('removeBot', ({ code, playerId, botId }, cb) => {
    const { error } = manager.removeBot(code, playerId, botId);
    if (error) return ackErr(cb, error);
    ackOk(cb);
    broadcast(code);
  });

  socket.on('startGame', ({ code, playerId }, cb) => {
    const { error } = manager.startGame(code, playerId);
    if (error) return ackErr(cb, error);
    ackOk(cb);
    broadcast(code);
  });

  // ---- in-game moves ----
  const withGame = (code, fn, cb) => {
    const room = manager.getRoom(code);
    if (!room || !room.game) return ackErr(cb, 'No active game.');
    const result = fn(room.game);
    if (result && result.ok === false) return ackErr(cb, result.error);
    ackOk(cb, result || {});
    manager.afterMutation(room);
  };

  socket.on('play', ({ code, playerId, cardIds, targetId, namedType }, cb) => {
    withGame(code, (g) => g.playCards(playerId, cardIds, { targetId, namedType }), cb);
  });

  socket.on('nope', ({ code, playerId }, cb) => {
    withGame(code, (g) => g.playNope(playerId), cb);
  });

  socket.on('declineNope', ({ code, playerId }, cb) => {
    withGame(code, (g) => g.declineNope(playerId), cb);
  });

  socket.on('draw', ({ code, playerId }, cb) => {
    withGame(code, (g) => g.drawCard(playerId), cb);
  });

  socket.on('continueTurn', ({ code, playerId }, cb) => {
    withGame(code, (g) => g.continueTurn(playerId), cb);
  });

  socket.on('continueExplode', ({ code, playerId }, cb) => {
    withGame(code, (g) => g.resolveExplode(playerId), cb);
  });

  socket.on('favorGive', ({ code, playerId, cardId }, cb) => {
    withGame(code, (g) => g.favorGive(playerId, cardId), cb);
  });

  socket.on('stealTake', ({ code, playerId, index }, cb) => {
    withGame(code, (g) => g.stealTake(playerId, index), cb);
  });

  socket.on('markTake', ({ code, playerId, index }, cb) => {
    withGame(code, (g) => g.markTake(playerId, index), cb);
  });

  socket.on('defusePlace', ({ code, playerId, index }, cb) => {
    withGame(code, (g) => g.defusePlace(playerId, index), cb);
  });

  socket.on('implodePlace', ({ code, playerId, index }, cb) => {
    withGame(code, (g) => g.implodePlace(playerId, index), cb);
  });

  socket.on('continueImplode', ({ code, playerId }, cb) => {
    withGame(code, (g) => g.resolveImplode(playerId), cb);
  });

  socket.on('dismissFuture', ({ code, playerId }, cb) => {
    withGame(code, (g) => g.dismissFuture(playerId), cb);
  });

  socket.on('alterFuture', ({ code, playerId, order }, cb) => {
    withGame(code, (g) => g.alterFuture(playerId, order), cb);
  });

  socket.on('leaveGame', ({ code, playerId }, cb) => {
    manager.leaveGame(code, playerId);
    socketIndex.delete(socket.id);
    if (playerSocket.get(playerId) === socket.id) playerSocket.delete(playerId);
    socket.leave(code);
    ackOk(cb);
    const room = manager.getRoom(code);
    if (room) {
      broadcast(code);
      if (room.game) manager.scheduleBots(room);
    }
  });

  socket.on('endGame', ({ code, playerId }, cb) => {
    const { error } = manager.endGame(code, playerId);
    if (error) return ackErr(cb, error);
    ackOk(cb);
    broadcast(code);
  });

  socket.on('playAgain', ({ code, playerId }, cb) => {
    const { error } = manager.playAgain(code, playerId);
    if (error) return ackErr(cb, error);
    ackOk(cb);
    broadcast(code);
  });

  socket.on('disconnect', () => {
    const info = socketIndex.get(socket.id);
    socketIndex.delete(socket.id);
    if (!info) return;
    // If the player already reconnected on a newer socket, this is a stale
    // disconnect for a connection they've replaced — do nothing, or we'd knock
    // them out and hand their seat to a bot right after they came back.
    if (playerSocket.get(info.playerId) !== socket.id) return;
    playerSocket.delete(info.playerId);
    manager.leaveRoom(info.code, info.playerId);
    const room = manager.getRoom(info.code);
    if (room) {
      broadcast(info.code);
      if (room.game) manager.scheduleBots(room); // AI covers the seat if needed
    }
  });
});

server.listen(PORT, () => {
  console.log(`🐱 Exploding Cats running at http://localhost:${PORT}`);
});
