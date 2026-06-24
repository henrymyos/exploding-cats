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
// explodePool = how many Exploding Kittens exist in the box (setup uses players-1).
// defuse      = total Defuse cards (one dealt to each player, the rest seeded back).
// catCount    = copies of each of the five collectible cats.
// feral       = copies of the wild Feral Cat (party only).
// actions     = count of each playable action card type in the deck.
const MODES = {
  original: {
    label: 'Original',
    maxPlayers: 5,
    explodePool: 4,
    defuse: 6,
    catCount: 4,
    feral: 0,
    actions: { NOPE: 5, ATTACK: 4, SKIP: 4, FAVOR: 4, SHUFFLE: 4, FUTURE: 5 },
  },
  party: {
    label: 'Party Pack',
    maxPlayers: 10,
    explodePool: 9,
    defuse: 10,
    catCount: 6,
    feral: 6,
    actions: {
      NOPE: 10, ATTACK: 5, TARGETED_ATTACK: 5, SKIP: 8, FAVOR: 6,
      SHUFFLE: 6, FUTURE: 6, ALTER: 6, DRAW_BOTTOM: 7,
    },
  },
};

function modeConfig(mode) {
  return MODES[mode] || MODES.original;
}

function catList() {
  return CATS.map((c) => ({ ...c }));
}

module.exports = { CATS, CARD_DEFS, MODES, modeConfig, catList };
