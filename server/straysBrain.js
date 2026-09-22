'use strict';

/*
 * Bot decisions for Stray Cats. Pure functions: (game, bot) -> target id (or null).
 * Bots know exactly what a human in their seat would: their own role, fellow
 * Strays if they're a Stray, and the Vet's own collar checks.
 */

function pickRandom(arr) { return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null; }

// Night, Stray: follow a teammate's pick so the pack agrees; else a random House Cat.
function choosePick(g, bot) {
  const already = Object.entries(g.picks).find(([id]) => id !== bot.id);
  if (already && Math.random() < 0.8) return already[1];
  const targets = g.aliveHouse();
  return pickRandom(targets) ? pickRandom(targets).id : null;
}

// Night, Vet: check a cat we haven't checked yet.
function choosePeek(g, bot) {
  const options = g.alivePlayers().filter((p) => p.id !== bot.id && !(p.id in g.vetKnowledge));
  const t = pickRandom(options.length ? options : g.alivePlayers().filter((p) => p.id !== bot.id));
  return t ? t.id : null;
}

// Day: who to vote for (null = skip).
function chooseVote(g, bot) {
  const others = g.alivePlayers().filter((p) => p.id !== bot.id);
  if (!others.length) return null;
  if (bot.role === 'stray') {
    // Strays vote together against a House Cat, riding any bandwagon that isn't a Stray.
    const house = others.filter((p) => p.role !== 'stray');
    const tally = {};
    for (const v of Object.values(g.votes)) if (v && house.some((p) => p.id === v)) tally[v] = (tally[v] || 0) + 1;
    const lead = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    if (lead && Math.random() < 0.7) return lead[0];
    return pickRandom(house) ? pickRandom(house).id : null;
  }
  if (bot.role === 'vet') {
    const known = others.find((p) => g.vetKnowledge[p.id] === 'stray');
    if (known) return known.id;
  }
  // House Cat: mostly join whoever's being accused, sometimes skip, otherwise a hunch.
  const tally = {};
  for (const v of Object.values(g.votes)) if (v && v !== bot.id) tally[v] = (tally[v] || 0) + 1;
  const lead = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  if (lead && Math.random() < 0.6) return lead[0];
  if (Math.random() < 0.2) return null;
  const cleared = new Set(Object.entries(g.vetKnowledge).filter(([, r]) => r === 'house').map(([id]) => id));
  const hunch = others.filter((p) => !cleared.has(p.id));
  const t = pickRandom(hunch.length ? hunch : others);
  return t ? t.id : null;
}

module.exports = { choosePick, choosePeek, chooseVote };
