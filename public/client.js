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

  // opponents (everyone but me) — show a fan of card backs for their hand
  const opp = $('opponents');
  opp.innerHTML = '';
  for (const p of g.players) {
    if (p.id === PLAYER_ID) continue;
    const div = document.createElement('div');
    div.className = 'opp' + (p.id === g.turnPlayerId ? ' active' : '') + (p.alive ? '' : ' dead');
    div.dataset.id = p.id;
    const fanCount = Math.min(p.handCount, 8);
    let fan = '';
    for (let i = 0; i < fanCount; i += 1) fan += '<span class="mini-back"></span>';
    div.innerHTML =
      `<div class="opp-head"><span class="opp-avatar">${p.isBot ? '🤖' : '😺'}</span>` +
      `<span class="opp-name">${escapeHtml(p.name)}</span></div>` +
      `<div class="opp-fan">${fan}</div>` +
      `<div class="opp-cards">${p.handCount} card${p.handCount === 1 ? '' : 's'}</div>`;
    opp.appendChild(div);
  }

  $('deckCount').textContent = g.deckCount;
  $('deckLeft').textContent = g.deckCount;
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
  handleDrawAnimation(g);
  handleDiscardAnimation(g);
  handleExplodeShake(g);
  handleTransfer(g);
  if (g.phase === 'finished') showVictory(g, lobby);
  else hideVictory();
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

  v.innerHTML =
    `<div class="confetti-layer">${confetti}</div>` +
    `<div class="victory-box">` +
      `<div class="trophy">🏆</div>` +
      `<h1>${youWon ? 'You win!' : escapeHtml((winner && winner.name) || 'Game over')}${youWon || !winner ? '' : ' wins!'}</h1>` +
      `<div class="victory-sub">last cat standing</div>` +
      buttons +
    `</div>`;
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
}

/* ---------------- table animations ---------------- */
// A face-down card flies from the deck to whoever just drew.
let prevDrawnKey = null;
function handleDrawAnimation(g) {
  const p = g.pending;
  const key = p && (p.kind === 'drawn' || p.kind === 'explode') ? p.actorId : null;
  if (key && key !== prevDrawnKey) {
    // Your own draw flies from the deck to the reveal card on the left;
    // opponents' draws fly from the deck to their seat.
    const target = key === PLAYER_ID ? $('drawReveal') : document.querySelector(`.opp[data-id="${cssId(key)}"]`);
    flyCard($('drawPile'), target); // face-down from the deck
  }
  prevDrawnKey = key;
}

// A face-up card flies from the player to the discard pile when one is played.
let prevDiscardCount = null;
function handleDiscardAnimation(g) {
  const dc = g.discardCount || 0;
  if (prevDiscardCount !== null && dc > prevDiscardCount && g.discardTop) {
    flyCard(discardSourceEl(g), $('discardTop'), g.discardTop);
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
  hand.innerHTML = '';
  if (!me) return;
  // keep only still-held selections
  const held = new Set(me.hand.map((c) => c.id));
  selected = new Set([...selected].filter((id) => held.has(id)));

  // "giving" mode: a Favor was played on me — highlight every card, tap to give.
  const giving = !!(g.pending && g.pending.kind === 'favorPick' && g.pending.youMustGive);
  hand.classList.toggle('giving', giving);

  for (const grp of groupHand(me.hand)) {
    const selCount = grp.cards.filter((c) => selected.has(c.id)).length;
    const stack = document.createElement('div');
    stack.className = 'stack' + (selCount > 0 ? ' sel' : '');
    // fan up to 4 identical cards
    grp.cards.slice(0, 4).forEach((card, i) => {
      const el = document.createElement('div');
      el.className = 'card';
      el.dataset.type = card.type;
      el.style.zIndex = String(i);
      if (i > 0) el.classList.add('fanned');
      el.innerHTML = cardFace(card);
      stack.appendChild(el);
    });
    if (grp.cards.length > 1) {
      const badge = document.createElement('span');
      badge.className = 'stack-count';
      badge.textContent = '×' + grp.cards.length;
      stack.appendChild(badge);
    }
    if (selCount > 0) {
      const pill = document.createElement('span');
      pill.className = 'stack-sel';
      pill.textContent = selCount + ' picked';
      stack.appendChild(pill);
    }
    stack.onclick = giving ? () => giveCard(grp.cards[0].id) : () => cycleGroup(grp, g, me);
    hand.appendChild(stack);
  }
  renderHandActions(g, me, isMyTurn);
}

// Give a chosen card to the player who played a Favor.
function giveCard(cardId) {
  socket.emit('favorGive', { code: state.code, playerId: PLAYER_ID, cardId }, (res) => {
    if (!res.ok) toast(res.error, true);
  });
}

// Tapping a stack cycles how many of that card are selected (0→1→…→max→0).
// Selecting a new group clears any previous selection.
function cycleGroup(grp, g, me) {
  if (!(g.turnPlayerId === PLAYER_ID) || g.pending) return;
  const k = grp.cards.filter((c) => selected.has(c.id)).length;
  const maxSel = grp.isCat ? Math.min(grp.cards.length, 3) : 1;
  const newK = k >= maxSel ? 0 : k + 1;
  selected = new Set(grp.cards.slice(0, newK).map((c) => c.id));
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
    <h2>${mode === 'favor' ? 'Ask a favor from whom?' : 'Steal from whom?'}</h2>
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
    };
  });
}

/* ---------------- pending (hiss / favor / future / defuse) ---------------- */
function renderPending(g, me) {
  const area = $('pendingArea');
  const p = g.pending;
  $('hissBar').classList.add('hidden');
  // Keep the left side panel for my own drawn card, or anyone's Exploding Cat.
  const keepReveal = p && ((p.kind === 'drawn' && p.youDrew) || p.kind === 'explode');
  if (!keepReveal) hideDrawReveal();
  if (!p) { area.textContent = ''; return; }
  area.textContent = p.description || '';

  // Hiss window: anyone (alive) with a Hiss can interrupt.
  if (p.kind === 'action' && me && me.alive) {
    const hasHiss = me.hand.some((c) => c.type === 'NOPE');
    if (hasHiss) {
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

  // Favor: I must give a card — prompt in place; the hand lights up to be tapped.
  if (p.kind === 'favorPick' && p.youMustGive) {
    area.textContent = `🎁 Tap a card to give to ${escapeHtml(p.actorName || 'them')}`;
  }

  // Defuse: I must place the exploding cat back
  if (p.kind === 'defuse' && p.youMustPlace) {
    showDefuse(p.maxIndex);
  }

  // Steal: I pick a face-down card from the target's hand
  if (p.kind === 'stealPick' && p.youSteal) {
    showStealPick(p);
  } else if (overlayMode === 'steal') {
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

// Everyone sees the Exploding Cat on the left before it resolves.
function showExplodeReveal(p) {
  const panel = $('drawReveal');
  const key = `explode:${p.actorId}`;
  if (revealShownFor === key) return;
  revealShownFor = key;
  const card = p.explodeCard || { type: 'EXPLODE', name: 'Exploding Kitten' };
  let msg;
  let btn = '';
  if (p.youExploded) {
    msg = p.hasDefuse ? '😼 Quick — play your Defuse!' : '💥 You exploded — you’re out!';
    btn = `<button class="btn danger" id="explodeContinueBtn">Continue</button>`;
  } else {
    msg = `${escapeHtml(p.actorName)} drew it!`;
  }
  panel.innerHTML =
    `<div class="reveal-title">💥 Exploding Kitten!</div>` +
    `<div class="reveal-card"><div class="card" data-type="EXPLODE">${cardFace(card)}</div></div>` +
    `<p class="hint">${msg}</p>${btn}`;
  panel.classList.remove('hidden');
  panel.classList.remove('pop'); void panel.offsetWidth; panel.classList.add('pop');
  const b = document.getElementById('explodeContinueBtn');
  if (b) b.onclick = () => {
    socket.emit('continueExplode', { code: state.code, playerId: PLAYER_ID }, (res) => {
      if (!res.ok) toast(res.error, true);
    });
  };
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
    <p class="hint">Sneak the Exploding Kitten back where the others won't expect it:</p>
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

/* ---------------- game menu (leave / end) ---------------- */
function goHome() {
  state.code = null;
  state.lobby = null;
  state.game = null;
  localStorage.removeItem('ec_code');
  closeOverlay();
  $('logPanel').classList.remove('open');
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
  max: ['max.png'],
  pepper: ['pepper.png'],
  gambit: ['gambit.png', 'gambit2.png'],
  loki: ['loki.png', 'loki2.png'],
  genevieve: ['genevieve.png'],
};

function photoFor(card) {
  const catId = card.type === 'CAT' ? card.cat : (ACTION_ART[card.type] || 'max');
  const list = CAT_PHOTOS[catId] || [`${catId}.png`];
  // hash the card id so each physical card keeps a stable photo, but copies vary
  const s = (card && (card.id || card.type)) || 'x';
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `/assets/cats/${list[h % list.length]}`;
}

function cardFace(card) {
  const isCat = card.type === 'CAT';
  const badge = isCat
    ? `<span class="corner-badge paw">${PAW_SVG}</span>`
    : `<span class="corner-badge glyph">${GLYPHS[card.type] || ''}</span>`;
  return (
    `<div class="card-art photo" data-type="${card.type}" style="background-image:url('${photoFor(card)}')">${badge}</div>` +
    `<div class="card-name">${escapeHtml(card.name)}</div>`
  );
}
function miniFace(card) {
  return cardFace(card);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
