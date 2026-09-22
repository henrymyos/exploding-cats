'use strict';

/*
 * Room persistence. Rooms (lobbies and games in progress) live in server memory;
 * without this a deploy or a Render restart wiped every table mid-game. Every
 * state change schedules a debounced save of all rooms to Upstash (same store
 * as the leaderboard); on boot we load them back and re-arm their timers, and
 * players' clients rejoin automatically with their remembered room code.
 *
 * Without KV_REST_API_URL / KV_REST_API_TOKEN this is a no-op.
 */

const KEY = 'cats:rooms:v1';
const MAX_AGE_MS = 12 * 60 * 60 * 1000;   // forget rooms untouched for 12h
const DEBOUNCE_MS = 400;

const URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const enabled = !!(URL && TOKEN);

async function redis(cmd) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

// Plain-data copy of a room: no timers, no functions, no transient reaction.
function serializeRoom(room) {
  const out = {
    code: room.code,
    hostId: room.hostId,
    creatorId: room.creatorId,
    gameType: room.gameType || 'cats',
    mode: room.mode,
    expansions: room.expansions || [],
    players: room.players.map((p) => ({ id: p.id, name: p.name, isBot: !!p.isBot, avatar: p.avatar || null, connected: !!p.connected })),
    scores: room.scores || {},
    streak: room.streak || null,
    reactionSeq: room.reactionSeq || 0,
    savedAt: Date.now(),
    game: null,
  };
  if (room.game) {
    const data = {};
    for (const [k, v] of Object.entries(room.game)) {
      if (typeof v === 'function') continue;
      data[k] = v;
    }
    out.game = { kind: room.game.kind || 'cats', data };
  }
  return out;
}

let timer = null;
let firstAt = 0;       // when the current debounce window opened
let lastJson = null;
let queue = Promise.resolve();
const MAX_WAIT_MS = 1500;   // a busy table can't postpone a save forever

function scheduleSave(rooms) {
  if (!enabled) return;
  const now = Date.now();
  if (!timer) firstAt = now;
  if (timer) clearTimeout(timer);
  const delay = now - firstAt >= MAX_WAIT_MS ? 0 : DEBOUNCE_MS;
  timer = setTimeout(() => {
    timer = null;
    const list = [];
    for (const room of rooms.values()) list.push(serializeRoom(room));
    const json = JSON.stringify(list);
    if (json === lastJson) return;
    lastJson = json;
    queue = queue.then(() => redis(['SET', KEY, json])).catch((e) => console.warn('room save failed:', e.message));
  }, delay);
}

async function load() {
  if (!enabled) return [];
  try {
    const raw = await redis(['GET', KEY]);
    const list = raw ? JSON.parse(raw) : [];
    const now = Date.now();
    return list.filter((r) => r && r.code && now - (r.savedAt || 0) < MAX_AGE_MS);
  } catch (e) {
    console.warn('room load failed:', e.message);
    return [];
  }
}

module.exports = { enabled, scheduleSave, load, serializeRoom };
