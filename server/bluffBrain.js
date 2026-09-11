'use strict';

/*
 * Bot decisions for Cat Bluff. Pure functions: (game, bot) -> move.
 * The bot knows its own dice and the total on the table, and assumes every
 * unseen die shows a given face with probability 1/3 (the face itself or a
 * wild 1), or 1/6 when the bid is on 1s.
 */

function expectedCount(g, bot, face) {
  const own = bot.dice.filter((d) => d === face || (face !== 1 && d === 1)).length;
  const unseen = g.totalDice() - bot.dice.length;
  return own + unseen * (face === 1 ? 1 / 6 : 1 / 3);
}

// Decide: call the current bid, or raise it.
function chooseMove(g, bot) {
  const bid = g.bid;
  const total = g.totalDice();
  const jitter = () => (Math.random() - 0.5) * 0.8;

  if (bid) {
    const exp = expectedCount(g, bot, bid.face);
    // Call when the bid is clearly beyond what the table likely holds.
    // Some randomness so the bots aren't perfectly predictable.
    if (bid.qty > exp + 1.2 + jitter()) return { kind: 'call' };
    if (bid.qty >= total) return { kind: 'call' };
  }

  // Raise: prefer the face we hold the most of (1s count toward every face).
  let bestFace = 2, bestOwn = -1;
  for (let f = 2; f <= 6; f += 1) {
    const own = bot.dice.filter((d) => d === f || d === 1).length;
    if (own > bestOwn || (own === bestOwn && Math.random() < 0.5)) { bestOwn = own; bestFace = f; }
  }
  const exp = expectedCount(g, bot, bestFace);
  let qty = Math.max(1, Math.round(exp + jitter() * 0.5));
  let face = bestFace;
  if (bid) {
    // Smallest legal raise on our favourite face, else bump the quantity.
    if (qty > bid.qty || (qty === bid.qty && face > bid.face)) { /* already legal */ }
    else if (face > bid.face) qty = bid.qty;
    else { qty = bid.qty + 1; }
    // Don't overreach: if the forced raise is well past expectation, call instead.
    if (qty > expectedCount(g, bot, face) + 1.5 + jitter()) return { kind: 'call' };
  }
  if (qty > total) return bid ? { kind: 'call' } : { kind: 'bid', qty: total, face };
  return { kind: 'bid', qty, face };
}

module.exports = { chooseMove, expectedCount };
