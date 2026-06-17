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

/* ---------------- bootstrap ---------------- */
fetch('/api/cats').then((r) => r.json()).then((c) => { CATS = c; }).catch(() => {});

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
  socket.emit('createRoom', { name, playerId: PLAYER_ID }, (res) => {
    if (!res.ok) return ($('homeError').textContent = res.error);
    state.code = res.code;
  });
};

$('joinBtn').onclick = () => {
  const name = currentName();
  const code = $('codeInput').value.trim().toUpperCase();
  if (!name) return ($('homeError').textContent = 'Enter your name first.');
  if (code.length !== 4) return ($('homeError').textContent = 'Enter the 4-letter room code.');
  socket.emit('joinRoom', { code, name, playerId: PLAYER_ID }, (res) => {
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
    socket.emit('joinRoom', { code: savedCode, name, playerId: PLAYER_ID }, (res) => {
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
  if (!game) { renderLobby(lobby); return showScreen('lobby'); }
  renderGame(game, lobby);
  showScreen('game');
}

/* ---------------- lobby render ---------------- */
function renderLobby(lobby) {
  $('lobbyCode').textContent = lobby.code;
  const list = $('lobbyPlayers');
  list.innerHTML = '';
  for (const p of lobby.players) {
    const li = document.createElement('li');
    const icon = p.isBot ? '🤖' : `<span class="dot ${p.connected ? '' : 'off'}"></span>`;
    const tag = p.id === lobby.hostId ? '<span class="host-tag">HOST</span>'
      : (p.isBot ? '<span class="bot-tag">BOT</span>' : '');
    li.innerHTML = `${icon}${escapeHtml(p.name)}${tag}`;
    list.appendChild(li);
  }
  const isHost = lobby.hostId === PLAYER_ID;
  const enough = lobby.players.length >= 2;
  const full = lobby.players.length >= 5;
  const botCount = lobby.players.filter((p) => p.isBot).length;

  $('botControls').style.display = isHost ? 'flex' : 'none';
  $('addBotBtn').disabled = full;
  $('removeBotBtn').disabled = botCount === 0;
  $('startBtn').style.display = isHost ? 'block' : 'none';
  $('startBtn').disabled = !enough;
  $('lobbyHint').textContent = isHost
    ? (enough ? 'Everyone in? Add bots to fill seats, then hit start!' : 'Add a bot or wait for another player (need at least 2)...')
    : 'Waiting for the host to start the game...';
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

/* ---------------- game render ---------------- */
function renderGame(g, lobby) {
  const me = g.players.find((p) => p.id === PLAYER_ID);
  // The player summary in g.players only has a handCount; our actual cards
  // come separately as g.hand. Attach them so the hand helpers can use me.hand.
  if (me) me.hand = g.hand || [];
  const isMyTurn = g.turnPlayerId === PLAYER_ID;

  // opponents (everyone but me)
  const opp = $('opponents');
  opp.innerHTML = '';
  for (const p of g.players) {
    if (p.id === PLAYER_ID) continue;
    const div = document.createElement('div');
    div.className = 'opp' + (p.id === g.turnPlayerId ? ' active' : '') + (p.alive ? '' : ' dead');
    div.innerHTML =
      `<div class="opp-avatar">${p.isBot ? '🤖' : '😺'}</div>` +
      `<div class="opp-name">${escapeHtml(p.name)}</div>` +
      `<div class="opp-cards">🂠 ${p.handCount}</div>`;
    opp.appendChild(div);
  }

  $('deckCount').textContent = g.deckCount;
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

  renderHand(g, me, isMyTurn);
  renderPending(g, me);
  renderLog(g.log);
}

function renderHand(g, me, isMyTurn) {
  const hand = $('hand');
  hand.innerHTML = '';
  if (!me) return;
  // keep only still-held selections
  const held = new Set(me.hand.map((c) => c.id));
  selected = new Set([...selected].filter((id) => held.has(id)));

  for (const card of me.hand) {
    const el = document.createElement('div');
    el.className = 'card' + (selected.has(card.id) ? ' selected' : '');
    el.dataset.type = card.type;
    el.innerHTML = cardFace(card);
    el.onclick = () => toggleSelect(card, g, me);
    hand.appendChild(el);
  }
  renderHandActions(g, me, isMyTurn);
}

function toggleSelect(card, g, me) {
  // Cat cards: allow multi-select of the SAME cat for combos. Others: single.
  if (selected.has(card.id)) { selected.delete(card.id); }
  else {
    if (card.type === 'CAT') {
      // drop any non-matching selections
      for (const id of [...selected]) {
        const c = me.hand.find((x) => x.id === id);
        if (!c || c.type !== 'CAT' || c.cat !== card.cat) selected.delete(id);
      }
    } else {
      selected.clear();
    }
    selected.add(card.id);
  }
  renderHandActions(g, me, g.turnPlayerId === PLAYER_ID);
  // re-mark selected without full rerender
  document.querySelectorAll('#hand .card').forEach((el, i) => {
    el.classList.toggle('selected', selected.has(me.hand[i].id));
  });
}

function renderHandActions(g, me, isMyTurn) {
  const bar = $('handActions');
  bar.innerHTML = '';
  if (!me || !me.alive || g.phase !== 'playing') return;

  const sel = [...selected].map((id) => me.hand.find((c) => c.id === id)).filter(Boolean);

  // Hiss is the only thing playable off-turn (handled by the hiss bar, see renderPending).
  if (!isMyTurn || g.pending) return;
  if (sel.length === 0) return;

  const allCat = sel.every((c) => c.type === 'CAT');
  if (allCat && sel.length >= 2) {
    const sameCat = sel.every((c) => c.cat === sel[0].cat);
    if (!sameCat) { addActionLabel(bar, 'Select matching cats to combo'); return; }
    if (sel.length === 2) addActionBtn(bar, 'Steal random card', () => promptTarget(me, g, sel, null));
    else if (sel.length === 3) addActionBtn(bar, 'Demand a card', () => promptNamed(me, g, sel));
    else addActionLabel(bar, 'Use 2 or 3 matching cats');
    return;
  }

  if (sel.length === 1) {
    const c = sel[0];
    if (c.type === 'CAT') { addActionLabel(bar, 'Need a matching pair'); return; }
    if (c.type === 'DEFUSE' || c.type === 'EXPLODE' || c.type === 'NOPE') {
      addActionLabel(bar, 'Can’t play that on its own'); return;
    }
    const label = `Play ${c.name}`;
    if (c.type === 'FAVOR') addActionBtn(bar, label, () => promptTarget(me, g, sel, 'favor'));
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
function aliveOpponents(g) {
  return g.players.filter((p) => p.alive && p.id !== PLAYER_ID && p.handCount > 0);
}

function promptTarget(me, g, sel, mode) {
  const opps = aliveOpponents(g);
  if (opps.length === 0) return toast('No one to target.', true);
  openOverlay(`
    <h2>${mode === 'favor' ? 'Beg from whom?' : 'Steal from whom?'}</h2>
    <div class="choice-grid">
      ${opps.map((p) => `<button class="choice" data-id="${p.id}">😺<br>${escapeHtml(p.name)}<br><span class="hint">${p.handCount} cards</span></button>`).join('')}
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
  // step 1: who
  openOverlay(`
    <h2>Demand from whom?</h2>
    <div class="choice-grid">
      ${opps.map((p) => `<button class="choice" data-id="${p.id}">😺<br>${escapeHtml(p.name)}</button>`).join('')}
    </div>
    <button class="btn" id="cancelOverlay">Cancel</button>
  `);
  $('cancelOverlay').onclick = closeOverlay;
  $('overlayBox').querySelectorAll('.choice').forEach((btn) => {
    btn.onclick = () => {
      const targetId = btn.dataset.id;
      // step 2: which card type
      const types = [
        { v: 'DEFUSE', n: 'Catnip' }, { v: 'NOPE', n: 'Hiss' }, { v: 'ATTACK', n: 'Pounce' },
        { v: 'SKIP', n: 'Scamper' }, { v: 'FAVOR', n: 'Beg' }, { v: 'SHUFFLE', n: 'Knock Off' },
        { v: 'FUTURE', n: 'Curious Peek' },
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
    };
  });
}

/* ---------------- pending (hiss / favor / future / defuse) ---------------- */
function renderPending(g, me) {
  const area = $('pendingArea');
  const p = g.pending;
  $('hissBar').classList.add('hidden');
  if (!p) { area.textContent = ''; return; }
  area.textContent = p.description || '';

  // Hiss window: anyone (alive) with a Hiss can interrupt.
  if (p.kind === 'action' && me && me.alive) {
    const hasHiss = me.hand.some((c) => c.type === 'NOPE');
    if (hasHiss) {
      $('hissText').textContent = p.noped ? 'Action HISSED — counter it?' : (p.description || 'An action is happening!');
      $('hissBar').classList.remove('hidden');
    }
  }

  // Curious Peek result (only the viewer gets the cards)
  if (p.kind === 'future' && p.futureCards) {
    showFuture(p.futureCards);
  } else if (p._overlay !== 'future') {
    if (overlayMode === 'future') closeOverlay();
  }

  // Favor: I must give a card
  if (p.kind === 'favorPick' && p.youMustGive) {
    showFavorGive(me);
  }

  // Defuse: I must place the exploding cat back
  if (p.kind === 'defuse' && p.youMustPlace) {
    showDefuse(p.maxIndex);
  }
}

$('hissBtn').onclick = () => {
  socket.emit('nope', { code: state.code, playerId: PLAYER_ID }, (res) => {
    if (!res.ok) toast(res.error, true);
  });
};

let overlayMode = null;
function showFuture(cards) {
  if (overlayMode === 'future') return; // already showing
  overlayMode = 'future';
  openOverlay(`
    <h2>🔮 Curious Peek</h2>
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

function showDefuse(maxIndex) {
  if (overlayMode === 'defuse') return;
  overlayMode = 'defuse';
  const options = [];
  options.push({ label: 'Top (next draw)', idx: 0 });
  if (maxIndex >= 2) options.push({ label: '2nd from top', idx: 1 });
  if (maxIndex >= 4) options.push({ label: 'Middle', idx: Math.floor(maxIndex / 2) });
  options.push({ label: 'Bottom', idx: maxIndex });
  options.push({ label: 'Random', idx: -1 });
  openOverlay(`
    <h2>🧨 Defused!</h2>
    <p class="hint">Sneak the Exploding Cat back where the others won't expect it:</p>
    <div class="choice-grid">
      ${options.map((o) => `<button class="choice" data-idx="${o.idx}">${o.label}</button>`).join('')}
    </div>
  `, true);
  $('overlayBox').querySelectorAll('.choice').forEach((btn) => {
    btn.onclick = () => {
      let idx = parseInt(btn.dataset.idx, 10);
      if (idx === -1) idx = Math.floor(Math.random() * (maxIndex + 1));
      socket.emit('defusePlace', { code: state.code, playerId: PLAYER_ID, index: idx }, (res) => {
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

/* ---------------- log ---------------- */
$('logToggle').onclick = () => $('logPanel').classList.toggle('open');
function renderLog(log) {
  const ul = $('logList');
  ul.innerHTML = '';
  for (const entry of [...log].reverse()) {
    const li = document.createElement('li');
    li.textContent = entry.text;
    ul.appendChild(li);
  }
}

/* ---------------- card faces ---------------- */

// Which cat's photo backs each action card (rotated so every cat shows up).
const ACTION_ART = {
  EXPLODE: 'gambit',
  DEFUSE: 'max',
  NOPE: 'pepper',
  ATTACK: 'loki',
  SKIP: 'genevieve',
  FAVOR: 'max',
  SHUFFLE: 'pepper',
  FUTURE: 'gambit',
};

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
};

const PAW_SVG = '<svg viewBox="0 0 64 64"><ellipse cx="32" cy="44" rx="13" ry="10"/><circle cx="17" cy="31" r="5.5"/><circle cx="47" cy="31" r="5.5"/><circle cx="25" cy="20" r="5.5"/><circle cx="39" cy="20" r="5.5"/></svg>';

function cardFace(card) {
  if (card.type === 'CAT') {
    return (
      `<div class="card-art cat-art" data-type="CAT" style="background-image:url('/assets/cats/${card.cat}.png')">` +
        `<span class="paw-badge">${PAW_SVG}</span>` +
        `<div class="art-fade"></div>` +
      `</div>` +
      `<div class="card-name">${escapeHtml(card.name)}</div>`
    );
  }
  const catId = ACTION_ART[card.type] || 'max';
  const glyph = GLYPHS[card.type] || '';
  return (
    `<div class="card-art" data-type="${card.type}" style="background-image:url('/assets/cats/${catId}.png')">` +
      `<div class="art-overlay"></div>` +
      `<span class="art-glyph">${glyph}</span>` +
    `</div>` +
    `<div class="card-name">${escapeHtml(card.name)}</div>`
  );
}
function miniFace(card) {
  return cardFace(card);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
