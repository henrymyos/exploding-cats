'use strict';

/*
 * Card catalogue for "Exploding Cats".
 *
 * Two decks are supported:
 *   - 'original': mirrors the standard 56-card Exploding Kittens deck (2-5 players)
 *   - 'party':    mirrors the Exploding Kittens Party Pack (up to 10 players),
 *                 adding Targeted Attack, Alter the Future, Draw From the Bottom
 *                 and the wild Feral Cat.
 *
 * The five "collectible" cat cards are YOUR cats. Edit CATS below to use their
 * real names. Drop a matching photo into public/assets/cats/ for each `id`.
 */

// ---- Your five cats. Rename these; keep the `id` matching the photo filename. ----
const CATS = [
  { id: 'max',       name: 'Max',       blurb: 'A pair of Maxes swipes a random card from a rival.' },
  { id: 'pepper',    name: 'Pepper',    blurb: 'Two Peppers? Snatch a card you cannot even see.' },
  { id: 'gambit',    name: 'Gambit',    blurb: 'Match a pair of Gambits to pull off a sneaky heist.' },
  { id: 'loki',      name: 'Loki',      blurb: 'Two Lokis make mischief — steal a random card.' },
  { id: 'genevieve', name: 'Genevieve', blurb: 'A regal pair of Genevieves demands tribute. Trios name the prize.' },
];

// ---- Shared catalogue: every card type's name + flavor text. ----
const CARD_DEFS = {
  EXPLODE:         { type: 'EXPLODE',         name: 'Exploding Kitten',      blurb: 'Draw one and you are out — unless you can defuse it.' },
  DEFUSE:          { type: 'DEFUSE',          name: 'Defuse',                blurb: 'Survive an Exploding Kitten and slip it back into the deck.' },
  NOPE:            { type: 'NOPE',            name: 'Nope',                  blurb: "Cancel another player's action. Nope a Nope to undo it." },
  ATTACK:          { type: 'ATTACK',          name: 'Attack',                blurb: 'End your turn and dump two turns on the next player.' },
  SKIP:            { type: 'SKIP',            name: 'Skip',                  blurb: 'End your turn right now without drawing a card.' },
  FAVOR:           { type: 'FAVOR',           name: 'Favor',                 blurb: 'Force any player to hand you a card of their choosing.' },
  SHUFFLE:         { type: 'SHUFFLE',         name: 'Shuffle',               blurb: 'Shuffle the draw pile into glorious chaos.' },
  FUTURE:          { type: 'FUTURE',          name: 'See the Future',        blurb: 'Privately look at the top three cards of the deck.' },
  // ---- Party Pack additions ----
  TARGETED_ATTACK: { type: 'TARGETED_ATTACK', name: 'Targeted Attack',       blurb: 'End your turn and force ANY player to take two turns.' },
  ALTER:           { type: 'ALTER',           name: 'Alter the Future',      blurb: 'Privately view AND rearrange the top three cards.' },
  DRAW_BOTTOM:     { type: 'DRAW_BOTTOM',     name: 'Draw From the Bottom',  blurb: 'End your turn by drawing the BOTTOM card instead of the top.' },
  FERAL:           { type: 'FERAL',           name: 'Feral Cat',             blurb: 'A wild cat — use it as any cat card in a combo.' },
};

// ---- Per-mode deck composition. ----
// A count map uses DEFUSE / CAT (copies per cat type) / FERAL plus action types.
// EXPLODE is seeded separately at (players - 1).
const MODES = {
  original: {
    label: 'Original',
    maxPlayers: 5,
    // Standard 56-card deck, fixed regardless of player count (2-5).
    counts: { DEFUSE: 6, CAT: 4, NOPE: 5, ATTACK: 4, SKIP: 4, FAVOR: 4, SHUFFLE: 4, FUTURE: 5 },
  },
  party: {
    label: 'Party Pack',
    maxPlayers: 10,
    // The box scales with player count via paw-print subsets:
    //   2-3 players -> paw cards only; 4-7 -> non-paw only; 8-10 -> all cards.
    paw:    { DEFUSE: 3, CAT: 3, FERAL: 2, NOPE: 3, ATTACK: 2, TARGETED_ATTACK: 2, SKIP: 4, FAVOR: 2, SHUFFLE: 2, FUTURE: 3, ALTER: 2, DRAW_BOTTOM: 3 },
    nonPaw: { DEFUSE: 7, CAT: 4, FERAL: 4, NOPE: 7, ATTACK: 3, TARGETED_ATTACK: 3, SKIP: 6, FAVOR: 4, SHUFFLE: 4, FUTURE: 3, ALTER: 4, DRAW_BOTTOM: 4 },
  },
};

// Lightweight per-mode info for the lobby (seat cap + label).
function modeConfig(mode) {
  const m = MODES[mode] || MODES.original;
  return { maxPlayers: m.maxPlayers, label: m.label };
}

// Resolve the actual deck composition for a mode + player count. Party Pack
// scales in three tiers like the physical box; Original is fixed.
function resolveDeck(mode, players) {
  const isParty = mode === 'party' && MODES.party;
  let counts;
  if (isParty) {
    const n = Math.max(2, Math.min(players || 5, 10));
    if (n <= 3) counts = { ...MODES.party.paw };
    else if (n <= 7) counts = { ...MODES.party.nonPaw };
    else {
      counts = {};
      const keys = new Set([...Object.keys(MODES.party.paw), ...Object.keys(MODES.party.nonPaw)]);
      keys.forEach((k) => { counts[k] = (MODES.party.paw[k] || 0) + (MODES.party.nonPaw[k] || 0); });
    }
  } else {
    counts = { ...MODES.original.counts };
  }
  const actions = {};
  for (const k of Object.keys(counts)) {
    if (k === 'DEFUSE' || k === 'CAT' || k === 'FERAL') continue;
    actions[k] = counts[k];
  }
  return {
    defuse: counts.DEFUSE || 0,
    catCount: counts.CAT || 0,
    feral: counts.FERAL || 0,
    explodePool: 9, // setup uses (players - 1); the box never needs more than 9
    actions,
  };
}

function catList() {
  return CATS.map((c) => ({ ...c }));
}

module.exports = { CATS, CARD_DEFS, MODES, modeConfig, resolveDeck, catList };
