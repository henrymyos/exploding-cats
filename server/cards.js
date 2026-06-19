'use strict';

/*
 * Card catalogue for "Exploding Cats — Family Edition".
 *
 * Mechanics mirror the standard 56-card party deck so the game stays balanced,
 * but every name and bit of flavor text here is original to this project.
 *
 * The five "collectible" cat cards are YOUR cats. Edit CATS below to use their
 * real names. Drop a matching photo into public/assets/cats/ for each `id`
 * (e.g. public/assets/cats/luna.png) and it shows up on the card automatically.
 */

// ---- Your five cats. Rename these; keep the `id` matching the photo filename. ----
const CATS = [
  { id: 'max',       name: 'Max',       blurb: 'A pair of Maxes swipes a random card from a rival.' },
  { id: 'pepper',    name: 'Pepper',    blurb: 'Two Peppers? Snatch a card you cannot even see.' },
  { id: 'gambit',    name: 'Gambit',    blurb: 'Match a pair of Gambits to pull off a sneaky heist.' },
  { id: 'loki',      name: 'Loki',      blurb: 'Two Lokis make mischief — steal a random card.' },
  { id: 'genevieve', name: 'Genevieve', blurb: 'A regal pair of Genevieves demands tribute. Trios name the prize.' },
];

// ---- Action / special cards. Counts match the standard balanced deck. ----
const ACTION_CARDS = {
  EXPLODE: {
    type: 'EXPLODE',
    name: 'Exploding Kitten',
    blurb: 'Draw one and you are out — unless you can defuse it.',
    count: 4, // box ships 4; setup uses (players - 1)
  },
  DEFUSE: {
    type: 'DEFUSE',
    name: 'Defuse',
    blurb: 'Survive an Exploding Kitten and slip it back into the deck.',
    count: 6,
  },
  NOPE: {
    type: 'NOPE',
    name: 'Nope',
    blurb: "Cancel another player's action. Nope a Nope to undo it.",
    count: 5,
  },
  ATTACK: {
    type: 'ATTACK',
    name: 'Attack',
    blurb: 'End your turn and dump two turns on the next player.',
    count: 4,
  },
  SKIP: {
    type: 'SKIP',
    name: 'Skip',
    blurb: 'End your turn right now without drawing a card.',
    count: 4,
  },
  FAVOR: {
    type: 'FAVOR',
    name: 'Favor',
    blurb: 'Force any player to hand you a card of their choosing.',
    count: 4,
  },
  SHUFFLE: {
    type: 'SHUFFLE',
    name: 'Shuffle',
    blurb: 'Shuffle the draw pile into glorious chaos.',
    count: 4,
  },
  FUTURE: {
    type: 'FUTURE',
    name: 'See the Future',
    blurb: 'Privately look at the top three cards of the deck.',
    count: 5,
  },
};

// Build the per-cat collectible card definition (4 copies each = 20 cards).
const CAT_CARD_COUNT = 4;

function catList() {
  return CATS.map((c) => ({ ...c }));
}

module.exports = { CATS, ACTION_CARDS, CAT_CARD_COUNT, catList };
