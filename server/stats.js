'use strict';

/*
 * All-time family leaderboard, shared across every room and game.
 *
 * Storage: Upstash Redis over REST when KV_REST_API_URL / KV_REST_API_TOKEN
 * (or UPSTASH_REDIS_REST_URL / _TOKEN) are set — that's what keeps it alive
 * across Render restarts and deploys. Without them it falls back to a JSON
 * file next to the server (fine for local play; wiped on each Render deploy).
 */

const fs = require('fs');
const path = require('path');

const KEY = 'cats:leaderboard:v1';
const FILE = path.join(__dirname, '..', 'data', 'leaderboard.json');
const URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const HISTORY_MAX = 100;

const empty = () => ({ players: {}, history: [] });
let cache = null;
let queue = Promise.resolve(); // serialise writes

function nameKey(name) { return (name || '').trim().toLowerCase(); }
function monthOf(ts) { return new Date(ts).toISOString().slice(0, 7); }   // 'YYYY-MM'
function bump(months, m, name, won) {
  const k = nameKey(name);
  if (!k) return;
  const bucket = months[m] || (months[m] = {});
  const e = bucket[k] || (bucket[k] = { name: name.trim(), games: 0, wins: 0 });
  e.name = name.trim();
  e.games += 1;
  if (won) e.wins += 1;
}

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

async function load() {
  if (cache) return cache;
  try {
    if (URL && TOKEN) {
      const raw = await redis(['GET', KEY]);
      cache = raw ? JSON.parse(raw) : empty();
    } else if (fs.existsSync(FILE)) {
      cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } else cache = empty();
  } catch (e) {
    console.warn('leaderboard load failed:', e.message);
    cache = empty();
  }
  if (!cache.players) cache.players = {};
  if (!cache.history) cache.history = [];
  // Monthly table, rebuilt from the recent-games history the first time.
  if (!cache.months) {
    cache.months = {};
    for (const h of cache.history) {
      const m = monthOf(h.ts);
      for (const name of h.players || []) bump(cache.months, m, name, h.winner === name);
    }
  }
  return cache;
}

async function save(data) {
  if (URL && TOKEN) {
    await redis(['SET', KEY, JSON.stringify(data)]);
  } else {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(data));
  }
}

/*
 * Record one finished game.
 *   game: 'cats' | 'bluff' | 'strays'
 *   standings: [{ id, name, isBot, place }]  (from Game.buildRecap)
 *   roomPlayers: room.players — used to skip bots and bot-driven abandoned seats
 */
function recordGame({ game, standings, roomPlayers }) {
  queue = queue.then(async () => {
    const data = await load();
    const humans = standings.filter((s) => {
      const rp = (roomPlayers || []).find((p) => p.id === s.id);
      return !s.isBot && !(rp && rp.isBot);
    });
    if (humans.length < 2) return; // solo vs bots doesn't count
    const ts = Date.now();
    for (const s of humans) {
      const k = nameKey(s.name);
      if (!k) continue;
      const e = data.players[k] || { name: s.name.trim(), games: 0, wins: 0, podiums: 0, byGame: {}, lastPlayed: 0 };
      e.name = s.name.trim();
      e.games += 1;
      if (s.place === 1) e.wins += 1;
      if (s.place <= 3) e.podiums += 1;
      const bg = e.byGame[game] || { games: 0, wins: 0 };
      bg.games += 1; if (s.place === 1) bg.wins += 1;
      e.byGame[game] = bg;
      e.lastPlayed = ts;
      data.players[k] = e;
    }
    const winner = humans.find((s) => s.place === 1) || standings.find((s) => s.place === 1);
    for (const s of humans) bump(data.months, monthOf(ts), s.name, s.place === 1);
    data.history.unshift({ ts, game, winner: winner ? winner.name : null, players: humans.map((s) => s.name) });
    if (data.history.length > HISTORY_MAX) data.history.length = HISTORY_MAX;
    await save(data);
  }).catch((e) => console.warn('leaderboard save failed:', e.message));
  return queue;
}

async function leaderboard() {
  const data = await load();
  const rows = Object.values(data.players)
    .map((e) => ({ ...e, winPct: e.games ? Math.round((100 * e.wins) / e.games) : 0 }))
    .sort((a, b) => b.wins - a.wins || b.winPct - a.winPct || b.games - a.games);
  const key = monthOf(Date.now());
  const month = Object.values(data.months[key] || {})
    .map((e) => ({ ...e, winPct: e.games ? Math.round((100 * e.wins) / e.games) : 0 }))
    .sort((a, b) => b.wins - a.wins || b.winPct - a.winPct || b.games - a.games);
  const label = new Date(Date.now()).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { players: rows, month: { key, label, players: month }, recent: data.history.slice(0, 10), persistent: !!(URL && TOKEN) };
}

module.exports = { recordGame, leaderboard };
