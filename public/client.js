'use strict';

/* ---------------- identity & connection ---------------- */
const socket = io();

// A stable per-browser id so a refresh/reconnect keeps your seat.
function getPlayerId() {
  let id = localStorage.getItem('ec_playerId');
  if (!id) {
    id = 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem('ec_playerId', id);
  }
  return id;
}
const PLAYER_ID = getPlayerId();

let CATS = [];
let state = { lobby: null, game: null, code: null };
let selected = new Set(); // selected card ids in hand

const $ = (id) => document.getElementById(id);
const screens = { home: $('home'), lobby: $('lobby'), game: $('game') };

// iOS home-screen (standalone) apps don't reliably fill the screen with %/vh/dvh,
// which left a gap below the hand. Pin the app height to the real window height so
// the game grid always reaches the bottom of the screen.
function setAppHeight() {
  const h = window.innerHeight;
  if (h) document.documentElement.style.setProperty('--app-height', h + 'px');
}
setAppHeight();
['resize', 'orientationchange', 'pageshow', 'load'].forEach((ev) =>
  window.addEventListener(ev, () => setTimeout(setAppHeight, 120)));

function showScreen(name) {
  for (const k of Object.keys(screens)) screens[k].classList.toggle('active', k === name);
}

function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', !!isErr);
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2600);
}

/* ---------------- sound: disabled — the game is fully silent ----------------
   No-op stub keeps every Sound.play()/resume() call site working without ever
   creating an AudioContext or emitting any noise. */
const Sound = { isMuted: () => true, toggle() { return true; }, resume() {}, play() {} };

/* ---------------- avatar (which cat represents you) ---------------- */
const AVATAR_CATS = ['max', 'pepper', 'gambit', 'loki', 'genevieve'];
let myAvatar = localStorage.getItem('ec_avatar') || AVATAR_CATS[Math.floor(Math.random() * AVATAR_CATS.length)];

function renderAvatarPicker() {
  const box = $('avatarPicker');
  if (!box) return;
  box.innerHTML = AVATAR_CATS.map((c) => {
    const label = c.charAt(0).toUpperCase() + c.slice(1);
    return `<div class="avatar-choice">` +
      `<button class="avatar-opt${c === myAvatar ? ' on' : ''}" data-cat="${c}" style="background-image:url('/assets/cats/${c}.png')" title="${label}"></button>` +
      `<span class="avatar-name">${label}</span>` +
    `</div>`;
  }).join('');
  box.querySelectorAll('.avatar-opt').forEach((b) => {
    b.onclick = () => { myAvatar = b.dataset.cat; localStorage.setItem('ec_avatar', myAvatar); renderAvatarPicker(); Sound.resume(); };
  });
}

/* ---------------- setting: also show my own seat in the top lineup ----------------
   Off by default. When on, the player's own tile is added to the top arc (left-most,
   marked "(You)") so they can see exactly where they sit in the clockwise turn order. */
let showMySeat = localStorage.getItem('ec_showMySeat') === '1';
function renderSeatToggle() {
  const btn = $('seatOrderToggle');
  if (!btn) return;
  btn.classList.toggle('on', showMySeat);
  btn.setAttribute('aria-pressed', showMySeat ? 'true' : 'false');
}
(function wireSeatToggle() {
  const btn = $('seatOrderToggle');
  if (!btn) return;
  btn.onclick = () => {
    showMySeat = !showMySeat;
    localStorage.setItem('ec_showMySeat', showMySeat ? '1' : '0');
    renderSeatToggle();
    lastArcSig = '';           // force the arc to re-lay-out with/without my seat
    if (state.game) render();  // reflect immediately if a game is already on screen
  };
  renderSeatToggle();
}());

/* ---------------- bootstrap ---------------- */
fetch('/api/cats').then((r) => r.json()).then((c) => { CATS = c; }).catch(() => {});
renderAvatarPicker();


/* ---------------- quick reactions ---------------- */
const REACT_EMOJIS = ['😹', '😿', '🙀', '😼', '😻', '👏', '💥', '🐱'];
(function buildReactBar() {
  const bar = $('reactBar');
  if (!bar) return;
  bar.innerHTML = REACT_EMOJIS.map((e) => `<button class="react-btn">${e}</button>`).join('');
  bar.querySelectorAll('.react-btn').forEach((b) => {
    b.onclick = () => socket.emit('react', { code: state.code, playerId: PLAYER_ID, emoji: b.textContent }, () => {});
  });
}());

if (localStorage.getItem('ec_name')) $('nameInput').value = localStorage.getItem('ec_name');

/* ---------------- home actions ---------------- */
function currentName() {
  const n = $('nameInput').value.trim();
  if (n) localStorage.setItem('ec_name', n);
  return n;
}

$('createBtn').onclick = () => {
  const name = currentName();
  if (!name) return ($('homeError').textContent = 'Enter your name first.');
  socket.emit('createRoom', { name, playerId: PLAYER_ID, avatar: myAvatar }, (res) => {
    if (!res.ok) return ($('homeError').textContent = res.error);
    state.code = res.code;
  });
};

$('joinBtn').onclick = () => {
  const name = currentName();
  const code = $('codeInput').value.trim().toUpperCase();
  if (!name) return ($('homeError').textContent = 'Enter your name first.');
  if (code.length !== 4) return ($('homeError').textContent = 'Enter the 4-letter room code.');
  socket.emit('joinRoom', { code, name, playerId: PLAYER_ID, avatar: myAvatar }, (res) => {
    if (!res.ok) return ($('homeError').textContent = res.error);
    state.code = res.code;
  });
};

$('startBtn').onclick = () => {
  socket.emit('startGame', { code: state.code, playerId: PLAYER_ID }, (res) => {
    if (!res.ok) toast(res.error, true);
  });
};

/* auto-rejoin after a refresh */
const savedCode = localStorage.getItem('ec_code');
socket.on('connect', () => {
  if (savedCode && state.code == null) {
    const name = $('nameInput').value.trim() || 'Player';
    socket.emit('joinRoom', { code: savedCode, name, playerId: PLAYER_ID, avatar: myAvatar }, (res) => {
      if (res.ok) state.code = res.code;
    });
  }
});

/* ---------------- state sync ---------------- */
socket.on('state', (payload) => {
  state.lobby = payload.lobby;
  state.game = payload.game || null;
  if (payload.lobby) {
    state.code = payload.lobby.code;
    localStorage.setItem('ec_code', payload.lobby.code);
  }
  render();
});

function render() {
  const { lobby, game } = state;
  if (!lobby) return showScreen('home');
  if (game) { renderGame(game, lobby); showScreen('game'); }
  else { renderLobby(lobby); showScreen('lobby'); }
  handleReaction(lobby);
}

/* ---------------- reaction display ---------------- */
let reactionStarted = false;
let lastReactionSeq = 0;
function handleReaction(lobby) {
  const r = lobby && lobby.reaction;
  if (!r) return;
  if (!reactionStarted) { reactionStarted = true; lastReactionSeq = r.seq; return; }
  if (r.seq !== lastReactionSeq) { lastReactionSeq = r.seq; popReaction(r); Sound.play('react'); }
}

function popReaction(r) {
  let anchor = null;
  if (state.game) {
    anchor = r.playerId === PLAYER_ID ? $('hand') : document.querySelector(`.opp[data-id="${cssId(r.playerId)}"]`);
  } else {
    anchor = document.querySelector(`#lobbyPlayers li[data-id="${cssId(r.playerId)}"]`);
  }
  if (!anchor) return;
  const rect = anchor.getBoundingClientRect();
  if (!rect.width) return;
  const el = document.createElement('div');
  el.className = 'reaction-pop';
  el.textContent = r.emoji;
  el.style.left = `${rect.left + rect.width / 2}px`;
  el.style.top = `${rect.top + 6}px`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1700);
}

/* ---------------- lobby render ---------------- */
function renderLobby(lobby) {
  $('lobbyCode').textContent = lobby.code;
  const list = $('lobbyPlayers');
  list.innerHTML = '';
  for (const p of lobby.players) {
    const li = document.createElement('li');
    const av = avatarHtml(p);
    const tag = p.id === lobby.hostId ? '<span class="host-tag">HOST</span>'
      : (p.isBot ? '<span class="bot-tag">BOT</span>' : '');
    const dot = p.isBot ? '' : `<span class="dot ${p.connected ? '' : 'off'}"></span>`;
    li.innerHTML = `${av}${dot}${escapeHtml(p.name)}${tag}`;
    list.appendChild(li);
  }
  renderScoreboard($('lobbyScores'), lobby);
  const isHost = lobby.hostId === PLAYER_ID;
  const isCreator = (lobby.creatorId || lobby.hostId) === PLAYER_ID;
  const mode = lobby.mode || 'original';
  const maxForMode = mode === 'party' ? 10 : 5;
  // deck selector: ONLY the game's creator can change it; everyone else sees it
  // as read-only (the chosen deck stays highlighted, but isn't tappable).
  const modeBox = $('modeSelect');
  modeBox.classList.toggle('readonly', !isCreator);
  modeBox.querySelectorAll('.mode-opt').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === mode);
    b.disabled = !isCreator;
    b.onclick = isCreator ? () => {
      socket.emit('setMode', { code: state.code, playerId: PLAYER_ID, mode: b.dataset.mode }, (res) => {
        if (res && !res.ok) toast(res.error, true);
      });
    } : null;
  });
  // expansion toggles — also creator-only
  const expansions = lobby.expansions || [];
  const expBox = $('expansionSelect');
  expBox.classList.toggle('readonly', !isCreator);
  expBox.querySelectorAll('.exp-opt').forEach((btn) => {
    const key = btn.dataset.exp;
    const on = expansions.includes(key);
    btn.classList.toggle('on', on);
    btn.disabled = !isCreator;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.onclick = isCreator ? () => {
      socket.emit('setExpansion', { code: state.code, playerId: PLAYER_ID, key, on: !on }, (res) => {
        if (res && !res.ok) toast(res.error, true);
      });
    } : null;
  });
  const enough = lobby.players.length >= 2;
  const full = lobby.players.length >= maxForMode;
  const botCount = lobby.players.filter((p) => p.isBot).length;

  $('botControls').style.display = isHost ? 'flex' : 'none';
  $('addBotBtn').disabled = full;
  $('removeBotBtn').disabled = botCount === 0;
  $('startBtn').style.display = isHost ? 'block' : 'none';
  $('startBtn').disabled = !enough;
}

// A player's avatar: their chosen cat photo, or an emoji fallback.
function avatarHtml(p) {
  if (p && p.avatar) return `<span class="avatar" style="background-image:url('/assets/cats/${p.avatar}.png')"></span>`;
  return `<span class="avatar emoji">${p && p.isBot ? '🤖' : '😺'}</span>`;
}

function renderScoreboard(el, lobby) {
  if (!el) return;
  const scores = (lobby && lobby.scores) || [];
  if (!scores.length) { el.innerHTML = ''; return; }
  const streak = lobby && lobby.streak;
  let html = '<h3 class="sb-title">🏆 Wins this room</h3><ul class="sb-list">';
  for (const s of scores) {
    const onStreak = streak && streak.id === s.id && streak.count >= 2;
    html += `<li><span class="sb-name">${escapeHtml(s.name)}${s.isBot ? ' 🤖' : ''}</span>` +
      `<span class="sb-wins">${s.wins}${onStreak ? ` <span class="sb-streak">🔥${streak.count}</span>` : ''}</span></li>`;
  }
  html += '</ul>';
  el.innerHTML = html;
}

$('addBotBtn').onclick = () => {
  socket.emit('addBot', { code: state.code, playerId: PLAYER_ID }, (res) => {
    if (!res.ok) toast(res.error, true);
  });
};
$('removeBotBtn').onclick = () => {
  socket.emit('removeBot', { code: state.code, playerId: PLAYER_ID }, (res) => {
    if (!res.ok) toast(res.error, true);
  });
};
$('leaveLobbyBtn').onclick = () => {
  socket.emit('leaveGame', { code: state.code, playerId: PLAYER_ID }, () => {});
  goHome();
};

/* ---------------- game render ---------------- */
let lastArcSig = ''; // seat set the opponent arc was last laid out for
function renderGame(g, lobby) {
  const me = g.players.find((p) => p.id === PLAYER_ID);
  // The player summary in g.players only has a handCount; our actual cards
  // come separately as g.hand. Attach them so the hand helpers can use me.hand.
  if (me) me.hand = g.hand || [];
  const isMyTurn = g.turnPlayerId === PLAYER_ID;
  // glow the screen edge yellow while it's your turn
  $('game').classList.toggle('my-turn', isMyTurn && g.phase === 'playing');
  // avatar lookup (avatars live on the lobby payload, not the game snapshot)
  const avById = {};
  (lobby && lobby.players ? lobby.players : []).forEach((p) => { avById[p.id] = p.avatar; });

  // opponents (everyone but me) — show a fan of card backs for their hand.
  // Reuse the tiles across renders (keyed by player id) so their arc positions
  // stay put; recreating them every action made each one re-animate out from the
  // top-centre default. Only brand-new seats get placed fresh.
  const opp = $('opponents');
  const prevOpp = new Map();
  opp.querySelectorAll(':scope > .opp').forEach((el) => prevOpp.set(el.dataset.id, el));
  // Seat everyone as if we're around one table: I'm at the bottom and the others
  // fan across the top in clockwise turn order — whoever acts right after me sits
  // left-most, whoever acts just before me sits right-most, so play sweeps me ->
  // left -> right -> back to me. (Reverse doesn't move seats; the turn-direction
  // indicator shows which way play is flowing.)
  const meIdx = g.players.findIndex((p) => p.id === PLAYER_ID);
  const others = meIdx >= 0
    ? g.players.slice(meIdx + 1).concat(g.players.slice(0, meIdx))
    : g.players.slice();
  // Normally the top arc is just the other players. With "show my seat" on, lead the
  // lineup with my own tile so I can see where I sit in the clockwise turn order.
  const opponents = (showMySeat && meIdx >= 0) ? [g.players[meIdx], ...others] : others;
  const keepIds = new Set();
  opponents.forEach((p, idx) => {
    let div = prevOpp.get(p.id);
    if (!div) {
      div = document.createElement('div');
      div.dataset.id = p.id;
      div.dataset.fresh = '1';                       // place without the move animation
    }
    const isMe = p.id === PLAYER_ID;
    div.className = 'opp' + (p.id === g.turnPlayerId ? ' active' : '') + (p.alive ? '' : ' dead') + (isMe ? ' me' : '');
    const fanCount = Math.min(p.handCount, 8);
    let fan = '';
    for (let i = 0; i < fanCount; i += 1) fan += '<span class="mini-back"></span>';
    const avEl = avById[p.id]
      ? `<span class="opp-avatar" style="background-image:url('/assets/cats/${avById[p.id]}.png')"></span>`
      : `<span class="opp-avatar emoji">${p.isBot ? '🤖' : '😺'}</span>`;
    // Mark (Streaking Kittens): a flipped card sits face-up at the TOP of the
    // owner's hand so everyone can see exactly what it is.
    const marked = (p.marked && p.marked.length)
      ? `<div class="opp-marked" title="Flipped face-up by a Mark card">${p.marked.map(markFace).join('')}</div>`
      : '';
    // (Streaking a live kitten is secret — opponents show no "holding a kitten" tag.)
    div.innerHTML =
      `<div class="opp-head">${avEl}<span class="opp-name">${escapeHtml(p.name)}</span>${isMe ? '<span class="you-tag">YOU</span>' : ''}</div>` +
      marked +
      `<div class="opp-fan">${fan}</div>` +
      `<div class="opp-cards">${p.handCount} card${p.handCount === 1 ? '' : 's'}</div>`;
    if (opp.children[idx] !== div) opp.insertBefore(div, opp.children[idx] || null);
    keepIds.add(p.id);
  });
  prevOpp.forEach((el, id) => { if (!keepIds.has(id)) el.remove(); });
  // fewer opponents -> bigger seat tiles (CSS keys off this), so 2 players don't
  // shrink into the corners.
  opp.dataset.count = String(opponents.length);
  // Only re-lay-out the arc when the set of seats actually changes (a player
  // joins/leaves). Re-arranging on every render made tiles slide a few px each
  // time a card count changed the tile width. (resize re-arranges separately.)
  const arcSig = opponents.map((p) => p.id).join(',');
  if (arcSig !== lastArcSig) { lastArcSig = arcSig; arrangeOpponentsArc(opp); }

  $('deckCount').textContent = g.deckCount;
  $('deckLeft').textContent = g.deckCount;
  renderOdds(g);
  renderTurnDir(g);
  const dt = $('discardTop');
  if (g.discardTop) {
    dt.className = 'card-mini';
    dt.dataset.type = g.discardTop.type;
    dt.style.cssText = '';
    dt.innerHTML = miniFace(g.discardTop);
  } else {
    dt.className = 'card-mini empty';
    dt.innerHTML = '';
  }

  // turn banner
  const banner = $('turnBanner');
  if (g.phase === 'finished') {
    const w = g.players.find((p) => p.id === g.winnerId);
    banner.textContent = w ? `🏆 ${w.name} wins!` : 'Game over.';
    banner.className = 'turn-banner you';
  } else {
    const turnP = g.players.find((p) => p.id === g.turnPlayerId);
    banner.textContent = isMyTurn
      ? `Your turn${g.turnsRemaining > 1 ? ` (${g.turnsRemaining} turns!)` : ''} — play cards or draw`
      : `${turnP ? turnP.name : '...'}'s turn`;
    banner.className = 'turn-banner' + (isMyTurn ? ' you' : '');
  }

  $('drawPile').disabled = !(isMyTurn && g.phase === 'playing' && !g.pending);

  // Streaking: warn if I'm secretly holding a live Exploding Kitten.
  const holdingKitten = !!(me && me.hand && me.hand.some((c) => c.type === 'EXPLODE'));
  $('liveKittenWarn').classList.toggle('hidden', !holdingKitten);

  renderHand(g, me, isMyTurn);
  renderPending(g, me);
  renderLog(g.log);
  handleDrawAnimation(g);
  handleDiscardAnimation(g);
  handleExplodeShake(g);
  handleTransfer(g);
  handleShuffle(g);
  handleTurnChime(g);
  if (g.phase === 'finished') showVictory(g, lobby);
  else hideVictory();
}

// Odds bar: chance the next drawn card is an Exploding Kitten, from the public
// kitten count and deck size. Colours green -> yellow -> red as it climbs.
function renderOdds(g) {
  const bar = $('oddsBar');
  const n = g.deckCount || 0;
  const k = g.kittensLeft || 0;
  if (g.phase !== 'playing' || n <= 0) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const risk = Math.min(1, k / n);
  // hue 120 (green) at 0 risk -> 60 (yellow) at 25% -> 0 (red) at 50%+
  const hue = Math.round(120 * (1 - Math.min(risk / 0.5, 1)));
  const color = `hsl(${hue}, 85%, 52%)`;
  $('oddsFill').style.width = (k > 0 ? Math.max(risk * 100, 3) : 0) + '%';
  $('oddsFill').style.backgroundColor = color;
  const pct = risk * 100;
  const pctStr = pct >= 9.95 ? Math.round(pct) + '%' : pct.toFixed(1) + '%';
  $('oddsText').style.color = color;
  $('oddsText').textContent = k > 0 ? `💥 ${pctStr} · ${k} in ${n}` : '💥 0% — no kittens left';
}

// Whose seat plays next, following the current turn direction (skipping the dead).
// A player still owing turns from an Attack goes again before the order moves on.
function nextUpPlayer(g) {
  const n = g.players.length;
  const cur = g.players.findIndex((p) => p.id === g.turnPlayerId);
  if (cur < 0) return null;
  if ((g.turnsRemaining || 1) > 1) return g.players[cur]; // attacked: same player again
  const step = g.direction === -1 ? -1 : 1;
  for (let s = 1; s <= n; s += 1) {
    const p = g.players[(cur + step * s + n * n) % n];
    if (p && p.alive) return p;
  }
  return null;
}

// Turn-direction indicator — only meaningful when Reverse can be played, i.e. the
// Imploding Kittens expansion (which ships the Reverse card) is enabled.
function renderTurnDir(g) {
  const el = $('turnDir');
  const hasReverse = Array.isArray(g.expansions) && g.expansions.includes('imploding');
  if (!hasReverse || g.phase !== 'playing') { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const reversed = g.direction === -1;
  el.classList.toggle('reversed', reversed);
  const next = nextUpPlayer(g);
  const arrow = reversed ? '↺' : '↻';
  const nextName = next ? (next.id === PLAYER_ID ? 'you' : next.name) : '—';
  el.innerHTML = `<span class="td-arrow">${arrow}</span>` +
    `<span class="td-text">${reversed ? 'Reversed' : 'Turn order'} · next: ${escapeHtml(nextName)}</span>`;
}

// Lay the opponents out along a downward-opening arc (a semicircle around the
// table) instead of a flat row: the middle seats sit highest, the outer ones
// curve down and tilt outward. Positions are absolute, computed from the count.
// The horizontal spread is clamped to the real tile width so the end seats never
// run off the side of the screen, and the seats are nudged down for breathing room.
function arrangeOpponentsArc(container) {
  const opps = Array.from(container.children);
  const n = opps.length;
  if (!n) { container.style.height = ''; return; }
  const narrow = window.matchMedia('(max-width: 480px)').matches;
  const short = window.innerHeight < 700;            // little vertical room — keep the arc shallow
  const TILT = 8;                                    // max outward tilt (deg)
  const BASE_TOP = short ? 3 : (narrow ? 6 : 10);
  // 6+ opponents (only possible in Party Pack) split across two stacked arcs so
  // they don't have to shrink into nothing on a phone.
  const rowsN = n >= 6 ? 2 : 1;

  // Position one row of seats on its own downward arc starting at baseTop;
  // returns the lowest tile bottom so the container can be sized.
  const arrangeRow = (els, baseTop, tileW, tileH, cw) => {
    const m = els.length;
    const RYbase = short ? (narrow ? 44 : 58) : (narrow ? 72 : 94);
    const RY = rowsN === 2 ? RYbase * 0.6 : RYbase;  // shallower arcs when stacked
    const spanDeg = m > 1 ? Math.min(26 * m, 130) : 0;
    const sinHalf = Math.sin((spanDeg / 2) * Math.PI / 180) || 1;
    const tiltR = TILT * Math.PI / 180;
    const halfExtent = (tileW / 2) * Math.cos(tiltR) + (tileH / 2) * Math.sin(tiltR);
    const maxOffset = Math.max(0, cw / 2 - halfExtent - 6);
    const sx = els.map((_, i) => {
      const f = m > 1 ? (i / (m - 1) - 0.5) : 0;
      return Math.sin(f * spanDeg * Math.PI / 180) / sinHalf;
    });
    let minGap = Infinity;
    for (let i = 1; i < sx.length; i += 1) minGap = Math.min(minGap, sx[i] - sx[i - 1]);
    const needed = (m > 1 && minGap > 0) ? (tileW + 6) / minGap : 0;
    const desired = cw * Math.min(narrow ? 0.42 : 0.40, 0.12 * m);
    const edgeOffset = Math.min(maxOffset, Math.max(desired, needed));
    let bottom = 0;
    els.forEach((el, i) => {
      const f = m > 1 ? (i / (m - 1) - 0.5) : 0;
      const ang = f * spanDeg * Math.PI / 180;
      const xpx = cw / 2 + edgeOffset * sx[i];
      const y = baseTop + RY * (1 - Math.cos(ang));
      const rot = f * TILT * 2;
      if (el.dataset.fresh) el.style.transition = 'none';
      el.style.left = xpx.toFixed(1) + 'px';
      el.style.top = y.toFixed(1) + 'px';
      el.style.transform = `translateX(-50%) rotate(${rot.toFixed(1)}deg)`;
      el.style.zIndex = el.classList.contains('active') ? '20' : String(Math.round(10 - Math.abs(f) * 8));
      bottom = Math.max(bottom, y + tileH);
    });
    return bottom;
  };

  const layout = () => {
    let tileW = 0, tileH = 0;
    opps.forEach((el) => { tileW = Math.max(tileW, el.offsetWidth); tileH = Math.max(tileH, el.offsetHeight); });
    if (!tileW) { tileW = narrow ? 70 : 96; tileH = narrow ? 78 : 90; }   // fallback while hidden
    const cw = container.clientWidth || container.getBoundingClientRect().width || window.innerWidth;
    let bottom;
    if (rowsN === 2) {
      const half = Math.ceil(n / 2);
      const back = opps.slice(0, half);   // back row sits higher
      const front = opps.slice(half);     // front row sits lower, clear of the back row
      const backBottom = arrangeRow(back, BASE_TOP, tileW, tileH, cw);
      bottom = arrangeRow(front, backBottom + 4, tileW, tileH, cw);
    } else {
      bottom = arrangeRow(opps, BASE_TOP, tileW, tileH, cw);
    }
    container.style.height = (bottom + 4) + 'px';
  };
  // renderGame can run while #game is still display:none (offsets read 0), so lay
  // out once with the fallback, then correct on the next frame when it's visible.
  layout();
  requestAnimationFrame(() => {
    layout();
    // restore transitions on freshly-placed seats so later moves (a player dies,
    // the screen resizes) still animate smoothly.
    opps.forEach((el) => { if (el.dataset.fresh) { delete el.dataset.fresh; el.style.transition = ''; } });
  });
}
// Re-flow the arc on rotation / resize (the live game re-renders on its own).
window.addEventListener('resize', () => {
  const c = document.getElementById('opponents');
  if (c && c.children.length) arrangeOpponentsArc(c);
});

// Track whether the player has scrolled the hand up off the bottom, so the
// sticky-bottom in renderHand only re-pins when they're already at the bottom.
(() => {
  const hand = document.getElementById('hand');
  if (!hand) return;
  hand.addEventListener('scroll', () => {
    const atBottom = hand.scrollTop + hand.clientHeight >= hand.scrollHeight - 4;
    hand.dataset.userScrolled = atBottom ? '0' : '1';
  });
})();

// A soft chime when your turn begins (and no blocking pending).
let prevWasMyTurn = false;
function handleTurnChime(g) {
  const myTurnNow = g.phase === 'playing' && g.turnPlayerId === PLAYER_ID && !g.pending;
  if (myTurnNow && !prevWasMyTurn) Sound.play('turn');
  prevWasMyTurn = myTurnNow;
}

/* ---------------- card-taken popup (taker + loser) ---------------- */
let transferStarted = false;
let lastTransferSeq = null;
function handleTransfer(g) {
  const t = g.transfer;
  if (!transferStarted) {
    // baseline on the first render this session — don't pop a pre-existing take
    transferStarted = true;
    lastTransferSeq = t ? t.seq : null;
    return;
  }
  if (t && t.seq !== lastTransferSeq) {
    showTransfer(t);
    lastTransferSeq = t.seq;
  }
}

function showTransfer(t) {
  const el = $('transfer');
  const label = t.youGained
    ? `You took this from ${escapeHtml(t.fromName)}`
    : `${escapeHtml(t.toName)} took this from you`;
  el.innerHTML =
    `<div class="card" data-type="${t.card.type}">${cardFace(t.card)}</div>` +
    `<div class="t-label">${label}</div>`;
  el.classList.remove('hidden');
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  clearTimeout(showTransfer._t);
  showTransfer._t = setTimeout(() => el.classList.add('hidden'), 3400);
}

/* ---------------- victory celebration + game-over menu ---------------- */
const CONFETTI_COLORS = ['#ff5e8a', '#ffcf5e', '#5ee0a8', '#7aa8ff', '#d99bff', '#ff8f6b'];
let victoryShown = false;
function showVictory(g, lobby) {
  if (victoryShown) return;
  victoryShown = true;
  const v = $('victory');
  const winner = g.players.find((p) => p.id === g.winnerId);
  const youWon = winner && winner.id === PLAYER_ID;
  const isHost = lobby && lobby.hostId === PLAYER_ID;
  const hostName = lobby ? (lobby.players.find((p) => p.id === lobby.hostId) || {}).name : '';

  let confetti = '';
  for (let i = 0; i < 70; i += 1) {
    const left = Math.floor(Math.random() * 100);
    const delay = (Math.random() * 2.5).toFixed(2);
    const dur = (2.2 + Math.random() * 2).toFixed(2);
    const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    confetti += `<span class="confetti" style="left:${left}%;background:${color};animation-delay:${delay}s;animation-duration:${dur}s"></span>`;
  }

  const buttons = isHost
    ? `<button class="btn primary" id="playAgainBtn">🔄 Play again (same crew)</button>` +
      `<button class="btn" id="vicHomeBtn">🏠 Back to home</button>`
    : `<p class="hint">Waiting for ${escapeHtml(hostName || 'the host')} to start a new game…</p>` +
      `<button class="btn" id="vicHomeBtn">🏠 Leave</button>`;

  const winnerAvatar = lobby && lobby.players ? (lobby.players.find((p) => p.id === g.winnerId) || {}).avatar : null;
  const crown = winnerAvatar
    ? `<div class="victory-avatar" style="background-image:url('/assets/cats/${winnerAvatar}.png')"></div>`
    : `<div class="trophy">🏆</div>`;
  const streak = lobby && lobby.streak;
  const streakLine = streak && streak.id === g.winnerId && streak.count >= 2
    ? `<div class="victory-streak">🔥 ${streak.count} wins in a row!</div>` : '';

  v.innerHTML =
    `<div class="confetti-layer">${confetti}</div>` +
    `<div class="victory-box">` +
      `<div class="victory-crown">🏆</div>` +
      crown +
      `<h1>${youWon ? 'You win!' : escapeHtml((winner && winner.name) || 'Game over')}${youWon || !winner ? '' : ' wins!'}</h1>` +
      `<div class="victory-sub">last cat standing</div>` +
      streakLine +
      `<div id="victoryScores" class="scoreboard"></div>` +
      buttons +
    `</div>`;
  renderScoreboard($('victoryScores'), lobby);
  Sound.play('victory');
  v.classList.remove('hidden');

  const pa = $('playAgainBtn');
  if (pa) pa.onclick = () => {
    socket.emit('playAgain', { code: state.code, playerId: PLAYER_ID }, (res) => {
      if (!res.ok) toast(res.error, true);
    });
  };
  const home = $('vicHomeBtn');
  if (home) home.onclick = () => {
    socket.emit('leaveGame', { code: state.code, playerId: PLAYER_ID }, () => {});
    goHome();
  };
}

function hideVictory() {
  const v = $('victory');
  if (v && !v.classList.contains('hidden')) v.classList.add('hidden');
  victoryShown = false;
}

/* ---------------- explosion shake ---------------- */
let prevAlive = null;
function handleExplodeShake(g) {
  const aliveNow = {};
  g.players.forEach((p) => { aliveNow[p.id] = p.alive; });
  if (prevAlive) {
    const someoneDied = g.players.some((p) => prevAlive[p.id] === true && p.alive === false);
    if (someoneDied) screenShake();
  }
  prevAlive = aliveNow;
}

function screenShake() {
  const app = $('app') || document.body;
  app.classList.remove('shake'); void app.offsetWidth; app.classList.add('shake');
  setTimeout(() => app.classList.remove('shake'), 650);
  const boom = $('boom');
  if (boom) { boom.classList.remove('on'); void boom.offsetWidth; boom.classList.add('on'); setTimeout(() => boom.classList.remove('on'), 650); }
  Sound.play('explode');
}

/* ---------------- table animations ---------------- */
// A face-down card flies from the deck to whoever just drew.
let prevDrawnKey = null;
function handleDrawAnimation(g) {
  const p = g.pending;
  const key = p && (p.kind === 'drawn' || p.kind === 'explode' || p.kind === 'implode') ? p.actorId : null;
  if (key && key !== prevDrawnKey) {
    // Your own draw flies from the deck to the reveal card on the left;
    // opponents' draws fly from the deck to their seat.
    const target = key === PLAYER_ID ? $('drawReveal') : document.querySelector(`.opp[data-id="${cssId(key)}"]`);
    flyCard($('drawPile'), target); // face-down from the deck
    if (key === PLAYER_ID) Sound.play('draw');
  }
  prevDrawnKey = key;
}

// A face-up card flies from the player to the discard pile when one is played.
let prevDiscardCount = null;
function handleDiscardAnimation(g) {
  const dc = g.discardCount || 0;
  if (prevDiscardCount !== null && dc > prevDiscardCount && g.discardTop) {
    flyCard(discardSourceEl(g), $('discardTop'), g.discardTop);
    Sound.play(g.discardTop.type === 'NOPE' ? 'nope' : 'play');
  }
  prevDiscardCount = dc;
}

// Who actually sent the card to the discard (e.g. a Nope flies from the noper,
// not the player whose action it interrupted). Falls back to the turn player.
function discardSourceEl(g) {
  const id = g.lastDiscardBy || g.turnPlayerId;
  if (id === PLAYER_ID) return $('hand');
  return document.querySelector(`.opp[data-id="${cssId(id)}"]`) || $('hand');
}

function cssId(id) {
  return String(id).replace(/"/g, '\\"');
}

// Animate a card from one element to another. With faceCard it flies face-up
// (a played card heading to the discard); without, it's a face-down draw.
function flyCard(fromEl, toEl, faceCard) {
  if (!fromEl || !toEl) return;
  const from = fromEl.getBoundingClientRect();
  const to = toEl.getBoundingClientRect();
  if (!from.width || !to.width) return; // elements not visible yet
  const w = 104, h = 146;
  const fly = document.createElement('div');
  fly.className = 'flying-card' + (faceCard ? ' faceup' : '');
  fly.style.width = `${w}px`;
  fly.style.height = `${h}px`;
  fly.style.left = `${from.left + from.width / 2 - w / 2}px`;
  fly.style.top = `${from.top + from.height / 2 - h / 2}px`;
  if (faceCard) {
    fly.innerHTML = `<div class="card" data-type="${faceCard.type}" style="width:100%;height:100%">${cardFace(faceCard)}</div>`;
  }
  document.body.appendChild(fly);
  // force layout so the transition runs
  // eslint-disable-next-line no-unused-expressions
  fly.getBoundingClientRect();
  const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
  const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
  if (faceCard) {
    fly.style.transform = `translate(${dx}px, ${dy}px) scale(.78) rotate(-5deg)`;
  } else {
    fly.style.transform = `translate(${dx}px, ${dy}px) scale(.45) rotate(10deg)`;
    fly.style.opacity = '0.25';
  }
  setTimeout(() => fly.remove(), 600);
}

// Play a riffle animation on the draw pile whenever the deck is shuffled.
let shuffleStarted = false;
let lastShuffleSeq = 0;
function handleShuffle(g) {
  const seq = g.shuffleSeq || 0;
  if (!shuffleStarted || seq < lastShuffleSeq) { shuffleStarted = true; lastShuffleSeq = seq; return; }
  if (seq > lastShuffleSeq) { lastShuffleSeq = seq; shuffleAnimation(); }
}

function shuffleAnimation() {
  const pile = $('drawPile');
  const back = pile && pile.querySelector('.pile-back');
  if (!back) return;
  const r = back.getBoundingClientRect();
  if (!r.width) return;
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  // card backs that fan out and snap back together
  const offsets = [[-72, -16, -16], [72, -16, 16], [-54, 16, -11], [54, 16, 11], [-26, -28, -6], [26, 28, 7]];
  offsets.forEach((o, i) => {
    const el = document.createElement('div');
    el.className = 'shuffle-card';
    el.style.width = `${r.width}px`;
    el.style.height = `${r.height}px`;
    el.style.left = `${cx - r.width / 2}px`;
    el.style.top = `${cy - r.height / 2}px`;
    el.style.setProperty('--dx', `${o[0]}px`);
    el.style.setProperty('--dy', `${o[1]}px`);
    el.style.setProperty('--rot', `${o[2]}deg`);
    el.style.animationDelay = `${i * 45}ms`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 950 + i * 45);
  });
  back.classList.remove('shuffling'); void back.offsetWidth; back.classList.add('shuffling');
  setTimeout(() => back.classList.remove('shuffling'), 800);
  Sound.play('shuffle');
  toast('🔀 Deck shuffled!');
}

// Display order for grouping the hand.
const TYPE_ORDER = ['DEFUSE', 'ATTACK', 'SKIP', 'FAVOR', 'SHUFFLE', 'FUTURE', 'NOPE', 'CAT', 'EXPLODE'];

// Group identical cards together and sort the groups for a tidy, stacked hand.
function groupHand(hand) {
  const groups = new Map();
  for (const card of hand) {
    const key = card.type === 'CAT' ? `cat:${card.cat}` : `type:${card.type}`;
    if (!groups.has(key)) {
      groups.set(key, { key, isCat: card.type === 'CAT', type: card.type, cat: card.cat, name: card.name, cards: [] });
    }
    groups.get(key).cards.push(card);
  }
  return [...groups.values()].sort((a, b) => {
    const ta = TYPE_ORDER.indexOf(a.type), tb = TYPE_ORDER.indexOf(b.type);
    if (ta !== tb) return ta - tb;
    return (a.cat || '').localeCompare(b.cat || '');
  });
}

function renderHand(g, me, isMyTurn) {
  const hand = $('hand');
  if (!me) { hand.innerHTML = ''; renderHandActions(g, me, isMyTurn); return; }
  // keep only still-held selections
  const held = new Set(me.hand.map((c) => c.id));
  selected = new Set([...selected].filter((id) => held.has(id)));

  // "giving" mode: a Favor was played on me — highlight every card, tap to give.
  const giving = !!(g.pending && g.pending.kind === 'favorPick' && g.pending.youMustGive);
  hand.classList.toggle('giving', giving);

  // Reconcile (don't wipe): reuse each stack by group key and each card element by
  // id, so unchanged photo-backed cards keep their DOM node and never repaint.
  const groups = groupHand(me.hand);
  const prevStacks = new Map();
  hand.querySelectorAll(':scope > .stack').forEach((el) => prevStacks.set(el.dataset.key, el));
  const keepKeys = new Set();

  groups.forEach((grp, idx) => {
    let stack = prevStacks.get(grp.key);
    if (!stack) { stack = document.createElement('div'); stack.dataset.key = grp.key; }
    const selCount = grp.cards.filter((c) => selected.has(c.id)).length;
    stack.className = 'stack' + (selCount > 0 ? ' sel' : '');

    // reconcile the fanned cards (up to 4) by card id
    const fanCards = grp.cards.slice(0, 4);
    const prevCards = new Map();
    stack.querySelectorAll(':scope > .card').forEach((el) => prevCards.set(el.dataset.cardId, el));
    const keepCardIds = new Set();
    fanCards.forEach((card, i) => {
      let el = prevCards.get(card.id);
      if (!el) {
        el = document.createElement('div');
        el.dataset.cardId = card.id;
        el.dataset.type = card.type;
        el.innerHTML = cardFace(card);            // build the photo once, then keep it
      }
      el.className = 'card' + (i > 0 ? ' fanned' : '') + (card.marked ? ' marked' : '');
      el.style.zIndex = String(i);
      if (stack.children[i] !== el) stack.insertBefore(el, stack.children[i] || null);
      keepCardIds.add(card.id);
    });
    prevCards.forEach((el, id) => { if (!keepCardIds.has(id)) el.remove(); });

    // count badge (×N) for stacks of 2+
    let badge = stack.querySelector(':scope > .stack-count');
    if (grp.cards.length > 1) {
      if (!badge) { badge = document.createElement('span'); badge.className = 'stack-count'; stack.appendChild(badge); }
      badge.textContent = '×' + grp.cards.length;
    } else if (badge) { badge.remove(); }

    // "N picked" pill while a selection is active
    let pill = stack.querySelector(':scope > .stack-sel');
    if (selCount > 0) {
      if (!pill) { pill = document.createElement('span'); pill.className = 'stack-sel'; stack.appendChild(pill); }
      pill.textContent = selCount + ' picked';
    } else if (pill) { pill.remove(); }

    stack.onclick = giving ? () => giveCard(grp.cards[0].id) : () => cycleGroup(grp, g, me);
    if (hand.children[idx] !== stack) hand.insertBefore(stack, hand.children[idx] || null);
    keepKeys.add(grp.key);
  });
  prevStacks.forEach((el, key) => { if (!keepKeys.has(key)) el.remove(); });

  renderHandActions(g, me, isMyTurn);

  // The hand grows upward and its last row hugs the bottom edge. On the rare giant
  // hand that's taller than its cap it scrolls — keep it stuck to the bottom so the
  // newest/bottom row stays in view, unless the player has scrolled up to look.
  requestAnimationFrame(() => {
    if (hand.scrollHeight <= hand.clientHeight + 1) return;   // fits, nothing to do
    if (hand.dataset.userScrolled !== '1') hand.scrollTop = hand.scrollHeight;
  });
}

// Give a chosen card to the player who played a Favor.
function giveCard(cardId) {
  socket.emit('favorGive', { code: state.code, playerId: PLAYER_ID, cardId }, (res) => {
    if (!res.ok) toast(res.error, true);
  });
}

// Tapping a stack cycles how many of it are selected. Cat-like cards (cats and
// wild Feral Cats) accumulate ACROSS stacks so you can combo e.g. a Max + a
// Feral; other action cards single-select on their own.
function isCatLike(card) { return card && (card.type === 'CAT' || card.type === 'FERAL'); }

function cycleGroup(grp, g, me) {
  if (!(g.turnPlayerId === PLAYER_ID) || g.pending) return;
  const k = grp.cards.filter((c) => selected.has(c.id)).length;
  const catLike = grp.isCat || grp.type === 'FERAL';
  if (catLike) {
    // Regular cats are pair-first: a stack you hold 2+ of jumps straight to a
    // pair on the first tap (the common steal), then trio, then a single, then
    // off. Feral Cats (wild) are single-first: one tap picks a single Feral so
    // you can pair it with any cat or another Feral; tapping again adds more.
    const m = grp.cards.length;
    const steps = grp.type === 'FERAL'
      ? (m >= 3 ? [1, 2, 3, 0] : m === 2 ? [1, 2, 0] : [1, 0])
      : (m >= 3 ? [2, 3, 1, 0] : m === 2 ? [2, 1, 0] : [1, 0]);
    const newK = steps[(steps.indexOf(k) + 1) % steps.length];
    const others = [...selected].filter((id) => {
      const c = me.hand.find((x) => x.id === id);
      return isCatLike(c) && !grp.cards.some((gc) => gc.id === id);
    });
    selected = new Set([...others, ...grp.cards.slice(0, newK).map((c) => c.id)]);
  } else {
    // single action card: just this one, on or off
    selected = new Set(k ? [] : [grp.cards[0].id]);
  }
  renderHand(g, me, g.turnPlayerId === PLAYER_ID);
}

function renderHandActions(g, me, isMyTurn) {
  const bar = $('handActions');
  bar.innerHTML = '';
  if (!me || !me.alive || g.phase !== 'playing') return;

  const sel = [...selected].map((id) => me.hand.find((c) => c.id === id)).filter(Boolean);

  // Hiss is the only thing playable off-turn (handled by the hiss bar, see renderPending).
  if (!isMyTurn || g.pending) return;
  if (sel.length === 0) return;

  // Cat combo (cats + wild Feral Cats). Real cats must match; Ferals are wild.
  const allCatLike = sel.every((c) => c.type === 'CAT' || c.type === 'FERAL');
  if (allCatLike && (sel.length >= 2 || (sel.length === 1 && sel[0].type === 'FERAL'))) {
    const reals = sel.filter((c) => c.type === 'CAT');
    const sameCat = reals.every((c) => c.cat === reals[0].cat);
    if (sel.length < 2) { addActionLabel(bar, 'Need a pair (Feral is wild)'); return; }
    if (sel.length > 3) { addActionLabel(bar, 'Use 2 or 3 cards'); return; }
    if (!sameCat) { addActionLabel(bar, 'Cats must match (Feral is wild)'); return; }
    if (sel.length === 2) addActionBtn(bar, 'Steal random card', () => promptTarget(me, g, sel, 'steal'));
    else addActionBtn(bar, 'Demand a card', () => promptNamed(me, g, sel));
    return;
  }

  if (sel.length === 1) {
    const c = sel[0];
    if (c.type === 'CAT') { addActionLabel(bar, 'Need a matching pair'); return; }
    if (c.type === 'DEFUSE' || c.type === 'EXPLODE' || c.type === 'NOPE' || c.type === 'IMPLODE') {
      addActionLabel(bar, 'Can’t play that on its own'); return;
    }
    if (c.type === 'STREAK') { addActionLabel(bar, 'Hold it — lets you survive an Exploding Kitten'); return; }
    if (c.type === 'ZOMBIE') { addActionLabel(bar, 'Hold it — saves you & revives a dead player'); return; }
    const label = `Play ${c.name}`;
    if (c.type === 'FAVOR') addActionBtn(bar, label, () => promptTarget(me, g, sel, 'favor'));
    else if (c.type === 'TARGETED_ATTACK') addActionBtn(bar, label, () => promptTarget(me, g, sel, 'attack'));
    else if (c.type === 'MARK') addActionBtn(bar, label, () => promptTarget(me, g, sel, 'mark'));
    else addActionBtn(bar, label, () => doPlay(sel.map((x) => x.id)));
    return;
  }
  addActionLabel(bar, 'Pick matching cat cards');
}

function addActionBtn(bar, label, fn) {
  const b = document.createElement('button');
  b.className = 'btn primary';
  b.textContent = label;
  b.onclick = fn;
  bar.appendChild(b);
}
function addActionLabel(bar, text) {
  const s = document.createElement('span');
  s.className = 'hint';
  s.textContent = text;
  bar.appendChild(s);
}

/* ---------------- moves ---------------- */
function doPlay(cardIds, extra = {}) {
  socket.emit('play', { code: state.code, playerId: PLAYER_ID, cardIds, ...extra }, (res) => {
    if (!res.ok) toast(res.error, true);
    else selected.clear();
  });
  closeOverlay();
}

$('drawPile').onclick = () => {
  socket.emit('draw', { code: state.code, playerId: PLAYER_ID }, (res) => {
    if (!res.ok) toast(res.error, true);
  });
};

/* ---------------- target / named pickers ---------------- */
// For steal/favor we need a player who holds cards; a Targeted Attack can hit
// anyone still alive.
function aliveOpponents(g, anyAlive) {
  // Same seating order as the arc: others clockwise from my seat (left -> right).
  const meIdx = g.players.findIndex((p) => p.id === PLAYER_ID);
  const seated = meIdx >= 0
    ? g.players.slice(meIdx + 1).concat(g.players.slice(0, meIdx))
    : g.players.slice();
  return seated.filter((p) => p.alive && p.id !== PLAYER_ID && (anyAlive || p.handCount > 0));
}

function promptTarget(me, g, sel, mode) {
  const opps = aliveOpponents(g, mode === 'attack');
  if (opps.length === 0) return toast('No one to target.', true);
  // only one other player — no need to ask
  if (opps.length === 1) { doPlay(sel.map((c) => c.id), { targetId: opps[0].id }); return; }
  const title = mode === 'favor' ? 'Ask a favor from whom?'
    : mode === 'attack' ? 'Attack whom?'
    : mode === 'mark' ? 'Mark whose card?' : 'Steal from whom?';
  openOverlay(`
    <h2>${title}</h2>
    <div class="choice-grid">
      ${opps.map((p) => `<button class="choice" data-id="${p.id}"><span class="choice-avatar">😺</span><span class="choice-name">${escapeHtml(p.name)}</span><span class="choice-sub">${p.handCount} cards</span></button>`).join('')}
    </div>
    <button class="btn" id="cancelOverlay">Cancel</button>
  `);
  $('overlayBox').querySelectorAll('.choice').forEach((btn) => {
    btn.onclick = () => doPlay(sel.map((c) => c.id), { targetId: btn.dataset.id });
  });
  $('cancelOverlay').onclick = closeOverlay;
}

function promptNamed(me, g, sel) {
  const opps = aliveOpponents(g);
  if (opps.length === 0) return toast('No one to target.', true);
  // only one other player — skip "who" and go straight to picking a card type
  if (opps.length === 1) { promptNamedType(opps[0].id, sel); return; }
  // step 1: who
  openOverlay(`
    <h2>Demand from whom?</h2>
    <div class="choice-grid">
      ${opps.map((p) => `<button class="choice" data-id="${p.id}"><span class="choice-avatar">😺</span><span class="choice-name">${escapeHtml(p.name)}</span><span class="choice-sub">${p.handCount} cards</span></button>`).join('')}
    </div>
    <button class="btn" id="cancelOverlay">Cancel</button>
  `);
  $('cancelOverlay').onclick = closeOverlay;
  $('overlayBox').querySelectorAll('.choice').forEach((btn) => {
    btn.onclick = () => promptNamedType(btn.dataset.id, sel);
  });
}

// step 2: which card type to demand
function promptNamedType(targetId, sel) {
  const types = [
    { v: 'DEFUSE', n: 'Defuse' }, { v: 'NOPE', n: 'Nope' }, { v: 'ATTACK', n: 'Attack' },
    { v: 'SKIP', n: 'Skip' }, { v: 'FAVOR', n: 'Favor' }, { v: 'SHUFFLE', n: 'Shuffle' },
    { v: 'FUTURE', n: 'See the Future' },
    ...CATS.map((c) => ({ v: c.id, n: c.name })),
  ];
  openOverlay(`
    <h2>Demand which card?</h2>
    <p class="hint">If they don't have it, you get nothing.</p>
    <div class="choice-grid">
      ${types.map((t) => `<button class="choice" data-v="${t.v}">${escapeHtml(t.n)}</button>`).join('')}
    </div>
    <button class="btn" id="cancelOverlay">Cancel</button>
  `);
  $('cancelOverlay').onclick = closeOverlay;
  $('overlayBox').querySelectorAll('.choice').forEach((b2) => {
    b2.onclick = () => doPlay(sel.map((c) => c.id), { targetId, namedType: b2.dataset.v });
  });
}

/* ---------------- pending (hiss / favor / future / defuse) ---------------- */
function renderPending(g, me) {
  const area = $('pendingArea');
  const p = g.pending;
  $('hissBar').classList.add('hidden');
  // Keep the left side panel for my own drawn card, or anyone's Exploding Cat.
  const keepReveal = p && ((p.kind === 'drawn' && p.youDrew) || p.kind === 'explode' || p.kind === 'implode');
  if (!keepReveal) hideDrawReveal();
  if (!p) { area.textContent = ''; return; }
  area.textContent = p.description || '';

  // Nope window: any alive player with a Nope can interrupt — except whoever
  // made the most recent play (you can't Nope your own action or your own Nope).
  if (p.kind === 'action' && me && me.alive && p.lastActorId !== PLAYER_ID) {
    const hasNope = me.hand.some((c) => c.type === 'NOPE');
    // Once you've declined this exact window, keep the prompt hidden so play
    // can move on without waiting out the timer. A counter-Nope changes the
    // window key (lastActorId / nopeCount) and the prompt returns.
    if (hasNope && declinedNopeKey !== nopeWindowKey(p)) {
      $('hissText').textContent = p.noped ? 'Action NOPED — counter it?' : (p.description || 'An action is happening!');
      $('hissBar').classList.remove('hidden');
    }
  }

  // Curious Peek result (only the viewer gets the cards)
  if (p.kind === 'future' && p.futureCards) {
    showFuture(p.futureCards);
  } else if (p._overlay !== 'future') {
    if (overlayMode === 'future') closeOverlay();
  }

  // Alter the Future: the viewer reorders the top three cards.
  if (p.kind === 'alter' && p.youAlter && p.futureCards) {
    showAlter(p.futureCards);
  } else if (overlayMode === 'alter') {
    closeOverlay();
  }

  // Favor: I must give a card — prompt in place; the hand lights up to be tapped.
  if (p.kind === 'favorPick' && p.youMustGive) {
    area.textContent = `🎁 Tap a card to give to ${escapeHtml(p.actorName || 'them')}`;
  }

  // Place a kitten back: Defuse (Exploding) or the face-up Imploding Kitten.
  if (p.kind === 'defuse' && p.youMustPlace) showDefuse(p.maxIndex, false);
  else if (p.kind === 'implodePlace' && p.youPlaceImplode) showDefuse(p.maxIndex, true);
  else if (overlayMode === 'defuse') closeOverlay();

  // Steal: I pick a face-down card from the target's hand
  if (p.kind === 'stealPick' && p.youSteal) {
    showStealPick(p);
  } else if (overlayMode === 'steal') {
    closeOverlay();
  }

  // Mark: I pick a face-down card from the target's hand to flip face-up
  if (p.kind === 'markPick' && p.youMark) {
    showMarkPick(p);
  } else if (overlayMode === 'mark') {
    closeOverlay();
  }

  // Draw reveal: I just drew a card — show it big, then Continue ends my turn.
  if (p.kind === 'drawn') {
    if (p.youDrew) showDrawReveal(p.youDrew);
    else area.textContent = `${p.actorName} is checking their draw…`;
  }

  // Exploding Cat reveal: shown to everyone on the left before it resolves.
  if (p.kind === 'explode') {
    showExplodeReveal(p);
    area.textContent = `💥 ${p.actorName} drew an Exploding Kitten!`;
  }

  // Imploding Kitten (fatal second draw) reveal.
  if (p.kind === 'implode') {
    showExplodeReveal(p);
    area.textContent = `☢️ ${p.actorName} drew the face-up Imploding Kitten — no escape!`;
  }
}

let revealShownFor = null;
function showDrawReveal(card) {
  const panel = $('drawReveal');
  if (revealShownFor === card.id) return; // already showing this draw
  revealShownFor = card.id;
  panel.innerHTML =
    `<div class="reveal-title">You drew…</div>` +
    `<div class="reveal-card"><div class="card" data-type="${card.type}">${cardFace(card)}</div></div>` +
    `<button class="btn primary" id="drawContinueBtn">Continue → end turn</button>`;
  panel.classList.remove('hidden');
  // small entrance animation
  panel.classList.remove('pop'); void panel.offsetWidth; panel.classList.add('pop');
  $('drawContinueBtn').onclick = () => {
    // fly the card from the left panel into your hand
    const cardEl = panel.querySelector('.reveal-card .card');
    if (cardEl) flyCard(cardEl, $('hand'), card);
    socket.emit('continueTurn', { code: state.code, playerId: PLAYER_ID }, (res) => {
      if (!res.ok) toast(res.error, true);
    });
    hideDrawReveal();
  };
}

function hideDrawReveal() {
  const panel = $('drawReveal');
  if (panel && !panel.classList.contains('hidden')) panel.classList.add('hidden');
  revealShownFor = null;
}

// Everyone sees the (Ex/Im)ploding Kitten on the left before it resolves.
function showExplodeReveal(p) {
  const panel = $('drawReveal');
  const isImplode = p.kind === 'implode';
  const key = `${p.kind}:${p.actorId}`;
  if (revealShownFor === key) return;
  revealShownFor = key;
  const card = p.explodeCard || { type: isImplode ? 'IMPLODE' : 'EXPLODE', name: isImplode ? 'Imploding Kitten' : 'Exploding Kitten' };
  const mine = p.actorId === PLAYER_ID;
  const title = isImplode ? '☢️ Imploding Kitten!' : '💥 Exploding Kitten!';
  let msg, btn = '';
  if (mine && isImplode) {
    msg = '☢️ No defuse can save you — you’re out!';
    btn = `<button class="btn danger" id="implodeContinueBtn">Continue</button>`;
  } else if (mine) {
    msg = p.hasDefuse ? '😼 Quick — play your Defuse!' : '💥 You exploded — you’re out!';
    btn = `<button class="btn danger" id="explodeContinueBtn">Continue</button>`;
  } else {
    msg = `${escapeHtml(p.actorName)} drew it!`;
  }
  panel.innerHTML =
    `<div class="reveal-title">${title}</div>` +
    `<div class="reveal-card"><div class="card" data-type="${card.type}">${cardFace(card)}</div></div>` +
    `<p class="hint">${msg}</p>${btn}`;
  panel.classList.remove('hidden');
  panel.classList.remove('pop'); void panel.offsetWidth; panel.classList.add('pop');
  const b = document.getElementById('explodeContinueBtn');
  if (b) b.onclick = () => socket.emit('continueExplode', { code: state.code, playerId: PLAYER_ID }, (res) => { if (!res.ok) toast(res.error, true); });
  const ib = document.getElementById('implodeContinueBtn');
  if (ib) ib.onclick = () => socket.emit('continueImplode', { code: state.code, playerId: PLAYER_ID }, (res) => { if (!res.ok) toast(res.error, true); });
}

// Identifies one Nope window. Changes whenever the chain advances (a Nope is
// played), which re-opens the prompt for anyone who'd declined the prior state.
function nopeWindowKey(p) { return `${p.seq}|${p.nopeCount}`; }
let declinedNopeKey = null;

$('hissBtn').onclick = () => {
  socket.emit('nope', { code: state.code, playerId: PLAYER_ID }, (res) => {
    if (!res.ok) toast(res.error, true);
  });
};

// "✕" — I won't Nope this. Tells the server to stop waiting on me so the
// action can resolve as soon as nobody else wants to interrupt.
$('hissDismiss').onclick = () => {
  const p = state.game && state.game.pending;
  if (p && p.kind === 'action') declinedNopeKey = nopeWindowKey(p);
  $('hissBar').classList.add('hidden');
  socket.emit('declineNope', { code: state.code, playerId: PLAYER_ID }, () => {});
};

let overlayMode = null;
function showFuture(cards) {
  if (overlayMode === 'future') return; // already showing
  overlayMode = 'future';
  openOverlay(`
    <h2>🔮 See the Future</h2>
    <p class="hint">Top of the deck (next to be drawn on the left):</p>
    <div class="future-row">
      ${cards.map((c, i) => `<div><div class="card" data-type="${c.type}">${cardFace(c)}</div><div class="label">${i === 0 ? 'next' : '#' + (i + 1)}</div></div>`).join('')}
    </div>
    <button class="btn primary" id="futureOk">Got it</button>
  `, true);
  $('futureOk').onclick = () => {
    socket.emit('dismissFuture', { code: state.code, playerId: PLAYER_ID }, () => {});
    closeOverlay();
  };
}

// Alter the Future: reorder the top three cards (left = next to be drawn).
function showAlter(cards) {
  if (overlayMode === 'alter') return; // already open — keep the in-progress order
  overlayMode = 'alter';
  let order = cards.slice(); // top-first
  const render = () => {
    openOverlay(`
      <h2>🔀 Alter the Future</h2>
      <p class="hint">Reorder the top of the deck (left = next draw). Use ◀ ▶ to move cards, then Done.</p>
      <div class="future-row">
        ${order.map((c, i) => `<div class="alter-card"><div class="card" data-type="${c.type}">${cardFace(c)}</div><div class="label">${i === 0 ? 'next' : '#' + (i + 1)}</div><div class="alter-moves"><button data-mv="l" data-i="${i}"${i === 0 ? ' disabled' : ''}>◀</button><button data-mv="r" data-i="${i}"${i === order.length - 1 ? ' disabled' : ''}>▶</button></div></div>`).join('')}
      </div>
      <button class="btn primary" id="alterDone">Done</button>
    `, true);
    $('overlayBox').querySelectorAll('[data-mv]').forEach((b) => {
      b.onclick = () => {
        const i = +b.dataset.i;
        const j = b.dataset.mv === 'l' ? i - 1 : i + 1;
        if (j < 0 || j >= order.length) return;
        [order[i], order[j]] = [order[j], order[i]];
        render();
      };
    });
    $('alterDone').onclick = () => {
      socket.emit('alterFuture', { code: state.code, playerId: PLAYER_ID, order: order.map((c) => c.id) }, () => {});
      closeOverlay();
    };
  };
  render();
}

function showFavorGive(me) {
  if (overlayMode === 'favor') return;
  overlayMode = 'favor';
  openOverlay(`
    <h2>🙏 Give a card</h2>
    <p class="hint">Choose a card to hand over:</p>
    <div class="choice-grid">
      ${me.hand.map((c) => `<button class="choice" data-id="${c.id}"><div class="card" data-type="${c.type}" style="pointer-events:none">${cardFace(c)}</div></button>`).join('')}
    </div>
  `, true);
  $('overlayBox').querySelectorAll('.choice').forEach((btn) => {
    btn.onclick = () => {
      socket.emit('favorGive', { code: state.code, playerId: PLAYER_ID, cardId: btn.dataset.id }, (res) => {
        if (!res.ok) toast(res.error, true);
      });
      closeOverlay();
    };
  });
}

// Blind steal: show the target's face-down fanned hand and pick one to take.
function showStealPick(p) {
  if (overlayMode === 'steal') return;
  overlayMode = 'steal';
  const n = Math.max(p.stealCount || 0, 0);
  let backs = '';
  for (let i = 0; i < n; i += 1) backs += `<button class="pick-back" data-i="${i}" title="Take this card"></button>`;
  openOverlay(
    `<h2>🐾 Swipe a card</h2>` +
    `<p class="hint">${escapeHtml(p.targetName)}'s hand is face-down — pick one to steal!</p>` +
    `<div class="pick-fan">${backs}</div>`,
    true
  );
  $('overlayBox').querySelectorAll('.pick-back').forEach((btn) => {
    btn.onclick = () => {
      socket.emit('stealTake', { code: state.code, playerId: PLAYER_ID, index: Number(btn.dataset.i) }, (res) => {
        if (!res.ok) toast(res.error, true);
      });
      closeOverlay();
    };
  });
}

// Mark: show the target's face-down hand and pick one to flip face-up for all.
function showMarkPick(p) {
  if (overlayMode === 'mark') return;
  overlayMode = 'mark';
  const n = Math.max(p.markCount || 0, 0);
  let backs = '';
  for (let i = 0; i < n; i += 1) backs += `<button class="pick-back" data-i="${i}" title="Flip this card face-up"></button>`;
  openOverlay(
    `<h2>🔖 Mark a card</h2>` +
    `<p class="hint">Pick one of ${escapeHtml(p.targetName)}'s face-down cards to flip face-up for everyone.</p>` +
    `<div class="pick-fan">${backs}</div>`,
    true
  );
  $('overlayBox').querySelectorAll('.pick-back').forEach((btn) => {
    btn.onclick = () => {
      socket.emit('markTake', { code: state.code, playerId: PLAYER_ID, index: Number(btn.dataset.i) }, (res) => {
        if (!res.ok) toast(res.error, true);
      });
      closeOverlay();
    };
  });
}

// Look through the (public, face-up) discard pile — grouped by card with counts,
// so you can see what's already been played, just like flipping through it in person.
function showDiscardPile() {
  const g = state.game;
  const pile = (g && g.discardPile) || [];
  overlayMode = 'discard';
  if (!pile.length) {
    openOverlay(`<h2>🗑️ Discard pile</h2><p class="hint">Nothing's been played yet.</p>`);
    return;
  }
  // group identical cards (cats keyed by their cat) and keep them in play order
  const groups = [];
  const byKey = {};
  pile.forEach((c) => {
    const key = c.type === 'CAT' ? `CAT:${c.cat}` : c.type;
    if (!byKey[key]) { byKey[key] = { card: c, count: 0 }; groups.push(byKey[key]); }
    byKey[key].count += 1;
  });
  groups.sort((a, b) => b.count - a.count);
  const chips = groups.map((grp) =>
    `<div class="discard-chip" data-type="${grp.card.type}">` +
      `<div class="dc-art" style="background-image:url('${photoFor(grp.card)}')"></div>` +
      `<span class="dc-name">${escapeHtml(grp.card.name)}</span>` +
      `<span class="dc-count">×${grp.count}</span>` +
    `</div>`
  ).join('');
  openOverlay(
    `<h2>🗑️ Discard pile (${pile.length})</h2>` +
    `<p class="hint">Every card that's been played so far.</p>` +
    `<div class="discard-view">${chips}</div>`
  );
}

function showDefuse(maxIndex, isImplode) {
  if (overlayMode === 'defuse') return;
  overlayMode = 'defuse';
  // index 0 = top (next draw), maxIndex = bottom. Offer only positions that exist
  // for the current deck size, skipping any that collapse onto another.
  const options = [];
  const seen = new Set();
  const add = (label, idx) => {
    if (idx >= 0 && idx <= maxIndex && !seen.has(idx)) { seen.add(idx); options.push({ label, idx }); }
  };
  add('Top (next draw)', 0);
  add('2nd from top', 1);
  add('3rd from top', 2);
  add('Bottom', maxIndex);
  const heading = isImplode ? '☢️ Imploding Kitten' : '🧨 Defused!';
  const hint = isImplode
    ? "It's face-up now — slide it back where someone else will draw it (no defuse can stop it):"
    : "Sneak the Exploding Kitten back where the others won't expect it:";
  openOverlay(`
    <h2>${heading}</h2>
    <p class="hint">${hint}</p>
    <div class="choice-grid">
      ${options.map((o) => `<button class="choice" data-idx="${o.idx}">${o.label}</button>`).join('')}
    </div>
  `, true);
  $('overlayBox').querySelectorAll('.choice').forEach((btn) => {
    btn.onclick = () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const ev = isImplode ? 'implodePlace' : 'defusePlace';
      socket.emit(ev, { code: state.code, playerId: PLAYER_ID, index: idx }, (res) => {
        if (!res.ok) toast(res.error, true);
      });
      closeOverlay();
    };
  });
}

/* ---------------- overlay helpers ---------------- */
function openOverlay(html, sticky) {
  $('overlayBox').innerHTML = html;
  $('overlay').classList.remove('hidden');
  $('overlay')._sticky = !!sticky;
}
function closeOverlay() {
  $('overlay').classList.add('hidden');
  overlayMode = null;
}
$('overlay').onclick = (e) => {
  if (e.target.id === 'overlay' && !$('overlay')._sticky) closeOverlay();
};

// Tap the discard pile to look through everything that's been played.
$('discardPile').onclick = () => showDiscardPile();

/* ---------------- game menu (leave / end) ---------------- */
function goHome() {
  state.code = null;
  state.lobby = null;
  state.game = null;
  localStorage.removeItem('ec_code');
  closeOverlay();
  hideVictory();      // the celebration is a separate fixed layer — hide it too
  hideDrawReveal();
  $('logPanel').classList.remove('open');
  lastArcSig = '';    // force the arc to re-lay-out for the next game
  showScreen('home');
}

$('menuToggle').onclick = () => {
  const isHost = state.lobby && state.lobby.hostId === PLAYER_ID;
  openOverlay(
    `<h2>Game menu</h2>` +
    `<p class="hint">Room <span class="code">${state.code || ''}</span></p>` +
    `<button class="btn primary" id="resumeBtn">Resume game</button>` +
    (isHost ? `<button class="btn" id="endBtn">End game → back to lobby</button>` : '') +
    `<button class="btn danger" id="leaveBtn">Leave game</button>`
  );
  $('resumeBtn').onclick = closeOverlay;
  $('leaveBtn').onclick = () => {
    socket.emit('leaveGame', { code: state.code, playerId: PLAYER_ID }, () => {});
    goHome();
  };
  const endBtn = document.getElementById('endBtn');
  if (endBtn) endBtn.onclick = () => {
    socket.emit('endGame', { code: state.code, playerId: PLAYER_ID }, (res) => {
      if (!res.ok) return toast(res.error, true);
      closeOverlay(); // server broadcasts the room back to the lobby
    });
  };
};

/* ---------------- log ---------------- */
$('logToggle').onclick = () => $('logPanel').classList.toggle('open');
$('logClose').onclick = () => $('logPanel').classList.remove('open');
function renderLog(log) {
  const ul = $('logList');
  ul.innerHTML = '';
  for (const entry of [...(log || [])].reverse()) {
    const li = document.createElement('li');
    li.textContent = entry.text;
    ul.appendChild(li);
  }
}

/* ---------------- card faces ---------------- */

// Clean white line/solid icons drawn over the cat photo for each action.
const GLYPHS = {
  EXPLODE: '<svg viewBox="0 0 64 64"><polygon points="32,2 39,22 60,16 45,32 60,48 39,42 32,62 25,42 4,48 19,32 4,16 25,22"/></svg>',
  DEFUSE: '<svg viewBox="0 0 64 64"><path d="M32 58 C32 32 44 14 60 10 C60 38 47 54 32 58 Z"/><path d="M32 58 C32 36 21 20 6 17 C6 41 19 55 32 58 Z" opacity=".75"/></svg>',
  NOPE: '<svg viewBox="0 0 64 64" fill="none" stroke="#fff" stroke-width="7"><circle cx="32" cy="32" r="24"/><line x1="15" y1="15" x2="49" y2="49"/></svg>',
  ATTACK: '<svg viewBox="0 0 64 64"><ellipse cx="32" cy="44" rx="15" ry="12"/><circle cx="15" cy="30" r="6.5"/><circle cx="49" cy="30" r="6.5"/><circle cx="24" cy="18" r="6.5"/><circle cx="40" cy="18" r="6.5"/></svg>',
  SKIP: '<svg viewBox="0 0 64 64"><polygon points="8,12 30,32 8,52"/><polygon points="32,12 54,32 32,52"/></svg>',
  FAVOR: '<svg viewBox="0 0 64 64"><path d="M32 56 C7 38 8 17 23 17 C31 17 32 26 32 26 C32 26 33 17 41 17 C56 17 57 38 32 56 Z"/></svg>',
  SHUFFLE: '<svg viewBox="0 0 64 64" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 20 H42 M34 12 l8 8 l-8 8"/><path d="M54 44 H22 M30 36 l-8 8 l8 8"/></svg>',
  FUTURE: '<svg viewBox="0 0 64 64"><path d="M6 32 C18 13 46 13 58 32 C46 51 18 51 6 32 Z" fill="none" stroke="#fff" stroke-width="6"/><circle cx="32" cy="32" r="9"/></svg>',
  // ---- Party Pack ----
  TARGETED_ATTACK: '<svg viewBox="0 0 64 64" fill="none" stroke="#fff" stroke-width="5"><circle cx="32" cy="32" r="22"/><circle cx="32" cy="32" r="11"/><path d="M32 4v10 M32 50v10 M4 32h10 M50 32h10" stroke-linecap="round"/></svg>',
  ALTER: '<svg viewBox="0 0 64 64" fill="none" stroke="#fff" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 22h28 M34 14l8 8-8 8"/><path d="M50 42H22 M30 34l-8 8 8 8"/></svg>',
  DRAW_BOTTOM: '<svg viewBox="0 0 64 64" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><path d="M32 8v36 M18 30l14 14 14-14"/><path d="M12 54h40"/></svg>',
  FERAL: '<svg viewBox="0 0 64 64"><ellipse cx="32" cy="44" rx="13" ry="10"/><circle cx="17" cy="31" r="5.5"/><circle cx="47" cy="31" r="5.5"/><circle cx="25" cy="20" r="5.5"/><circle cx="39" cy="20" r="5.5"/><path d="M44 6l3 7 7 3-7 3-3 7-3-7-7-3 7-3z"/></svg>',
  // ---- Expansions ----
  IMPLODE: '<svg viewBox="0 0 64 64"><path d="M32 32 L14 8 A30 30 0 0 1 50 8 Z"/><path d="M32 32 L56 14 A30 30 0 0 1 56 50 Z" opacity=".8"/><path d="M32 32 L50 56 A30 30 0 0 1 14 56 Z" opacity=".6"/><path d="M32 32 L8 50 A30 30 0 0 1 8 14 Z" opacity=".7"/><circle cx="32" cy="32" r="5" fill="#1a1430"/></svg>',
  REVERSE: '<svg viewBox="0 0 64 64" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><path d="M16 26 A18 18 0 0 1 48 22 M48 14 v10 h-10"/><path d="M48 38 A18 18 0 0 1 16 42 M16 50 v-10 h10"/></svg>',
  MARK: '<svg viewBox="0 0 64 64"><path d="M44 6 H20 a4 4 0 0 0-4 4 v48 l16-10 16 10 V10 a4 4 0 0 0-4-4z"/></svg>',
  SWAP_TB: '<svg viewBox="0 0 64 64" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12 v40 M22 12 l-8 8 M22 12 l8 8"/><path d="M42 52 V12 M42 52 l-8-8 M42 52 l8-8"/></svg>',
  STREAK: '<svg viewBox="0 0 64 64"><ellipse cx="32" cy="44" rx="13" ry="10"/><circle cx="17" cy="31" r="5.5"/><circle cx="47" cy="31" r="5.5"/><circle cx="25" cy="20" r="5.5"/><circle cx="39" cy="20" r="5.5"/><path d="M6 12 h16 M4 22 h12" stroke="#fff" stroke-width="4" stroke-linecap="round"/></svg>',
  ZOMBIE: '<svg viewBox="0 0 64 64"><circle cx="32" cy="30" r="22"/><circle cx="24" cy="28" r="4.5" fill="#1a1430"/><circle cx="40" cy="28" r="4.5" fill="#1a1430"/><path d="M22 42 h20 M27 42 v6 M32 42 v6 M37 42 v6" stroke="#1a1430" stroke-width="2.5"/></svg>',
};

const PAW_SVG = '<svg viewBox="0 0 64 64"><ellipse cx="32" cy="44" rx="13" ry="10"/><circle cx="17" cy="31" r="5.5"/><circle cx="47" cy="31" r="5.5"/><circle cx="25" cy="20" r="5.5"/><circle cx="39" cy="20" r="5.5"/></svg>';

// Stylized vector portraits of each cat, matched to their real coloring.
// Each cat can be drawn in several poses (see catSVG / POSES below).
const POSES = ['sit', 'loaf', 'sleep'];
const CAT_ILLUS = {
  max:       { base:'#e8913f', stroke:'#b5670f', chest:'#fbe9d2', muzzle:'#fbe9d2', inner:'#f4b3aa', eye:'#6fae54', stripes:true, sc:'#b5670f' },
  pepper:    { base:'#9b9288', stroke:'#6a6258', chest:'#e9e4dc', muzzle:'#e9e4dc', inner:'#f0b6ad', eye:'#8ab04f', stripes:true, sc:'#5f584f' },
  gambit:    { base:'#2c2c2c', stroke:'#0c0c0c', chest:'#ffffff', muzzle:'#ffffff', inner:'#e08f8f', eye:'#9bd36b' },
  loki:      { base:'#f1e7d4', stroke:'#cdbfa3', chest:'#ffffff', muzzle:'#ffffff', inner:'#f4b3aa', eye:'#7fb0c9', earBase:'#e8913f', cap:'M-58,-10 A60 60 0 0 1 58,-10 C 40,-30 -40,-30 -58,-10 Z', capColor:'#e8913f' },
  genevieve: { base:'#ffffff', stroke:'#c4c9d0', chest:'#ffffff', muzzle:'#ffffff', inner:'#f0b6ad', eye:'#d2a23c', earBase:'#8f969e', cap:'M-58,-6 A60 60 0 0 1 58,-6 C 40,-24 30,8 0,8 C -30,8 -40,-24 -58,-6 Z', capColor:'#8f969e' },
};

// Face + ears + markings, drawn centered at local (0,0) with head radius 60.
function catHead(o, sleep) {
  const ear = (s) =>
    `<polygon points="${s * 22},-48 ${s * 32},-90 ${s * 58},-46" fill="${o.earBase || o.base}" stroke="${o.stroke}" stroke-width="3" stroke-linejoin="round"/>` +
    `<polygon points="${s * 28},-50 ${s * 34},-74 ${s * 50},-48" fill="${o.inner}"/>`;
  const cap = o.cap ? `<path d="${o.cap}" fill="${o.capColor}"/>` : '';
  const stripes = o.stripes
    ? `<g stroke="${o.sc}" stroke-width="5" stroke-linecap="round" fill="none"><path d="M0,-46 v22"/><path d="M-16,-42 l-5 18"/><path d="M16,-42 l5 18"/><path d="M-58,4 q14 5 0 11"/><path d="M58,4 q-14 5 0 11"/></g>`
    : '';
  const eye = (cx) => sleep
    ? `<path d="M${cx - 12},-2 q12 10 24 0" stroke="#1c1c22" stroke-width="4" fill="none" stroke-linecap="round"/>`
    : `<ellipse cx="${cx}" cy="-2" rx="13" ry="16" fill="#1c1c22"/><ellipse cx="${cx}" cy="-2" rx="6" ry="11" fill="${o.eye}"/><circle cx="${cx + 4}" cy="-7" r="3" fill="#fff"/>`;
  return `${ear(-1)}${ear(1)}<circle r="60" fill="${o.base}" stroke="${o.stroke}" stroke-width="3"/>${cap}${stripes}` +
    `<path d="M0,34 C -36,34 -52,10 -52,-8 L 52,-8 C 52,10 36,34 0,34 Z" fill="${o.muzzle}"/>` +
    `${eye(-24)}${eye(24)}` +
    `<polygon points="0,12 -8,19 8,19" fill="#e08aa0"/>` +
    `<path d="M0,19 v7 M0,26 q-9 7 -16 2 M0,26 q9 7 16 2" stroke="#7a5a4a" stroke-width="3" fill="none" stroke-linecap="round"/>` +
    `<g stroke="${o.stroke}" stroke-width="2.5" stroke-linecap="round" opacity=".75"><path d="M-34,4 l-32 -7 M-34,12 l-32 4"/><path d="M34,4 l32 -7 M34,12 l32 4"/></g>`;
}

// Draw a cat in one of the POSES. Reuses catHead so the face stays consistent.
function catSVG(catId, kind) {
  const o = CAT_ILLUS[catId];
  if (!o) return null;
  kind = kind || 'sit';
  if (kind === 'sit') {
    return `<svg viewBox="0 0 240 260">` +
      `<path d="M168 238 C 222 232 224 172 203 150 C 196 166 200 206 164 214 Z" fill="${o.base}" stroke="${o.stroke}" stroke-width="3"/>` +
      `<path d="M120 132 C 68 132 58 240 76 256 L 164 256 C 182 240 172 132 120 132 Z" fill="${o.base}" stroke="${o.stroke}" stroke-width="3"/>` +
      `<ellipse cx="120" cy="214" rx="30" ry="38" fill="${o.chest}"/>` +
      `<ellipse cx="100" cy="254" rx="15" ry="10" fill="${o.chest}"/><ellipse cx="140" cy="254" rx="15" ry="10" fill="${o.chest}"/>` +
      `<g transform="translate(120,86)">${catHead(o, false)}</g></svg>`;
  }
  if (kind === 'loaf') {
    return `<svg viewBox="0 0 240 260">` +
      `<path d="M196 214 C 232 206 230 176 212 170 C 210 184 206 200 184 204 Z" fill="${o.base}" stroke="${o.stroke}" stroke-width="3"/>` +
      `<ellipse cx="120" cy="196" rx="92" ry="50" fill="${o.base}" stroke="${o.stroke}" stroke-width="3"/>` +
      `<ellipse cx="120" cy="206" rx="30" ry="26" fill="${o.chest}"/>` +
      `<ellipse cx="92" cy="236" rx="19" ry="9" fill="${o.chest}"/><ellipse cx="148" cy="236" rx="19" ry="9" fill="${o.chest}"/>` +
      `<g transform="translate(120,104)">${catHead(o, false)}</g></svg>`;
  }
  // sleep (curled up, eyes closed)
  return `<svg viewBox="0 0 240 260">` +
    `<circle cx="128" cy="158" r="80" fill="${o.base}" stroke="${o.stroke}" stroke-width="3"/>` +
    `<path d="M60 196 C 36 226 110 250 188 214" fill="none" stroke="${o.base}" stroke-width="24" stroke-linecap="round"/>` +
    `<path d="M60 196 C 36 226 110 250 188 214" fill="none" stroke="${o.stroke}" stroke-width="24" stroke-linecap="round" opacity=".18"/>` +
    `<ellipse cx="150" cy="150" rx="44" ry="34" fill="${o.chest}" opacity=".55"/>` +
    `<g transform="translate(96,150) rotate(18)">${catHead(o, true)}</g></svg>`;
}

// Pick a pose deterministically from a card's id, so each physical card keeps
// the same pose between renders but different copies show different poses.
function poseFor(card) {
  const s = (card && (card.id || card.type)) || 'x';
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return POSES[h % POSES.length];
}

// Real photos per cat. Cats with several shots rotate poses across card copies.
const CAT_PHOTOS = {
  max: ['max.png', 'max2.png', 'max3.png', 'max4.png'],
  pepper: ['pepper.png', 'pepper2.png', 'pepper3.png'],
  gambit: ['gambit.png', 'gambit2.png', 'gambit3.png'],
  loki: ['loki.png', 'loki2.png', 'loki3.png'],
  genevieve: ['genevieve.png', 'genevieve2.png', 'genevieve3.png'],
};

// Every photo of every cat — used only as a fallback pool.
const ALL_PHOTOS = Object.values(CAT_PHOTOS).reduce((a, list) => a.concat(list), []);

// Each action card TYPE owns an exclusive set of photos: a photo assigned to one
// type never backs another, so e.g. an Attack photo can't also appear on Skip or
// Favor. (The cat types cover every cat photo exactly once.) The Feral Cat — the
// wild card — is the odd one out: it's backed by photos of Stella the dog.
const STELLA_PHOTOS = [
  'stella.png', 'stella2.png', 'stella3.png', 'stella4.png', 'stella5.png',
  'stella6.png', 'stella7.png', 'stella8.png', 'stella9.png', 'stella10.png',
  'stella11.png', 'stella12.png', 'stella13.png', 'stella14.png', 'stella15.png',
];
const ACTION_PHOTOS = {
  EXPLODE:  ['gambit.png', 'gambit2.png'],
  DEFUSE:   ['max.png', 'max2.png'],
  NOPE:     ['pepper.png', 'pepper2.png'],
  ATTACK:   ['loki.png', 'loki2.png'],
  SKIP:     ['genevieve.png', 'genevieve2.png'],
  FAVOR:    ['max3.png', 'max4.png'],
  SHUFFLE:  ['pepper3.png', 'gambit3.png'],
  FUTURE:   ['loki3.png', 'genevieve3.png'],
  // Party Pack types reuse photos thematically (attack-like, future-like, ...).
  TARGETED_ATTACK: ['loki.png', 'loki2.png'],
  ALTER:           ['loki3.png', 'genevieve3.png'],
  DRAW_BOTTOM:     ['pepper3.png', 'gambit3.png'],
  FERAL:           STELLA_PHOTOS, // the wild card is our dog, Stella
  // Expansion types
  IMPLODE:         ['gambit.png', 'gambit2.png'],
  REVERSE:         ['pepper.png', 'pepper2.png'],
  MARK:            ['max3.png', 'max4.png'],
  SWAP_TB:         ['pepper3.png', 'gambit3.png'],
  ZOMBIE:          ['gambit2.png', 'gambit3.png'],
};

function photoFor(card) {
  // Cat cards: a photo OF THAT cat. Action cards: a photo from that type's own set.
  const list = card.type === 'CAT'
    ? (CAT_PHOTOS[card.cat] || [`${card.cat}.png`])
    : (ACTION_PHOTOS[card.type] || ALL_PHOTOS);
  // hash the card id so each physical card keeps a stable photo, but copies vary
  const s = (card && (card.id || card.type)) || 'x';
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `/assets/cats/${list[h % list.length]}`;
}

function cardFace(card) {
  const isCat = card.type === 'CAT';
  const isFeral = card.type === 'FERAL';
  const badge = isCat
    ? `<span class="corner-badge paw">${PAW_SVG}</span>`
    : `<span class="corner-badge ${isFeral ? 'paw' : 'glyph'}">${isFeral ? GLYPHS.FERAL : (GLYPHS[card.type] || '')}</span>`;
  return (
    `<div class="card-art photo" data-type="${card.type}" style="background-image:url('${photoFor(card)}')">${badge}</div>` +
    `<div class="card-name">${escapeHtml(card.name)}</div>`
  );
}
function miniFace(card) {
  return cardFace(card);
}

// A small face-up card shown at the top of an opponent's hand after a Mark
// flips it — the photo, the name, and a bookmark tag, so everyone can read it.
// Carries data-type so the press-and-hold / hover tooltip works on it too.
function markFace(card) {
  return (
    `<div class="mark-card" data-type="${card.type}">` +
      `<span class="mark-flag">🔖</span>` +
      `<div class="mark-art" style="background-image:url('${photoFor(card)}')"></div>` +
      `<span class="card-name mark-name">${escapeHtml(card.name)}</span>` +
    `</div>`
  );
}

/* ---------------- card tooltips (hover / press-and-hold) ---------------- */
const CARD_DESC = {
  EXPLODE: 'Draw one and you’re out — unless you can defuse it.',
  DEFUSE: 'Survive an Exploding Kitten and secretly slip it back into the deck.',
  NOPE: 'Cancel another player’s action. Play a Nope on a Nope to undo it.',
  ATTACK: 'End your turn without drawing and force the next player to take two turns (they stack: 2 → 4 → 6).',
  SKIP: 'End your turn immediately without drawing a card.',
  FAVOR: 'Force a player to give you one card — of their choosing.',
  SHUFFLE: 'Shuffle the draw pile.',
  FUTURE: 'Privately look at the top three cards of the deck.',
  CAT: 'No power alone. Play 2 matching cats to steal a random card, or 3 to demand a specific card type.',
  TARGETED_ATTACK: 'End your turn and force ANY player you choose to take two turns.',
  ALTER: 'Privately view AND rearrange the top three cards of the deck.',
  DRAW_BOTTOM: 'End your turn by drawing the BOTTOM card instead of the top.',
  FERAL: 'A wild cat — use it as any cat in a pair or three-of-a-kind.',
  IMPLODE: 'Can’t be defused. The first draw flips it face-up and you reposition it; the next draw is fatal.',
  REVERSE: 'Reverse the turn order and end your turn without drawing.',
  STREAK: 'While you hold this, you can keep a live Exploding Kitten in your hand without dying. Lose it and you explode!',
  MARK: 'Flip a random card in another player’s hand face-up for everyone to see.',
  SWAP_TB: 'Swap the top and bottom cards of the draw pile.',
  ZOMBIE: 'Survive an Exploding Kitten — and drag a dead player back to life.',
};

function showCardTip(el) {
  const type = el.dataset.type;
  const desc = CARD_DESC[type];
  if (!desc) return;
  const nameEl = el.querySelector('.card-name');
  const name = nameEl ? nameEl.textContent : (type || '');
  const tip = $('cardTip');
  tip.innerHTML = `<b>${escapeHtml(name)}</b><span>${escapeHtml(desc)}</span>`;
  tip.classList.remove('hidden');
  const r = el.getBoundingClientRect();
  const tr = tip.getBoundingClientRect();
  let left = r.left + r.width / 2 - tr.width / 2;
  left = Math.max(6, Math.min(left, window.innerWidth - tr.width - 6));
  let top = r.top - tr.height - 8;
  if (top < 6) top = r.bottom + 8; // flip below if no room above
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}
function hideCardTip() { $('cardTip').classList.add('hidden'); }

// Desktop: hover with intent (the cursor must rest on a card a beat before the tip
// shows). Mobile: press-and-hold. Either way, actually tapping/clicking a card
// dismisses the tip so it never covers the Play button.
const TIP_SEL = '.card[data-type], .card-mini[data-type], .mark-card[data-type], .discard-chip[data-type]';
const TIP_HOVER_DELAY = 650;  // ms the cursor must hover a card before the tip appears
const TIP_HOLD_DELAY = 650;   // ms to press-and-hold (touch) before the tip appears
let tipPressTimer = null, tipSwallowClick = false;
let tipHoverTimer = null, tipHoverCard = null;

function cancelTipTimers() { clearTimeout(tipHoverTimer); clearTimeout(tipPressTimer); tipHoverCard = null; }

document.addEventListener('mouseover', (e) => {
  const card = e.target.closest && e.target.closest(TIP_SEL);
  if (!card || card === tipHoverCard) return;   // same card: let the pending timer keep running
  tipHoverCard = card;
  clearTimeout(tipHoverTimer);
  tipHoverTimer = setTimeout(() => showCardTip(card), TIP_HOVER_DELAY);
});
document.addEventListener('mouseout', (e) => {
  const card = e.target.closest && e.target.closest(TIP_SEL);
  if (!card) return;
  if (e.relatedTarget && card.contains(e.relatedTarget)) return;  // moved within the same card, still hovering
  tipHoverCard = null;
  clearTimeout(tipHoverTimer);
  hideCardTip();
});
document.addEventListener('touchstart', (e) => {
  const card = e.target.closest && e.target.closest(TIP_SEL);
  if (!card) return;
  clearTimeout(tipPressTimer);
  tipPressTimer = setTimeout(() => { tipSwallowClick = true; showCardTip(card); }, TIP_HOLD_DELAY);
}, { passive: true });
function endPress() { clearTimeout(tipPressTimer); setTimeout(hideCardTip, 1400); }
document.addEventListener('touchend', endPress);
document.addEventListener('touchmove', () => { clearTimeout(tipPressTimer); hideCardTip(); });
document.addEventListener('touchcancel', endPress);
// A long-press shows the tip and its trailing click is swallowed (so it doesn't also
// select). A real tap/click on a card instead dismisses the tip and selects, so the
// description never sits on top of the Play button.
document.addEventListener('click', (e) => {
  if (tipSwallowClick) { tipSwallowClick = false; e.stopPropagation(); e.preventDefault(); return; }
  if (e.target.closest && e.target.closest(TIP_SEL)) { cancelTipTimers(); hideCardTip(); }
}, true);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
