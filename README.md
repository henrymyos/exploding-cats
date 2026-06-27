# 🐱 Exploding Cats — Family Edition

A real-time, online, multiplayer card game for your family, built around your
own five cats. The rules play just like the popular exploding-kittens-style
party game, but every card name, illustration, and bit of flavor text is
original to this project, and the five collectible cat cards are *your* cats.

Each player joins from their own phone or laptop using a shared 4-letter room
code. The server is the single source of truth, so nobody can peek at hidden
cards or cheat.

## Quick start

```bash
npm install
npm start
```

Then open <http://localhost:3000> in a browser. On your home network, others can
join from `http://<your-computer-ip>:3000`. The live game is deployed on Vercel.
Note that the multiplayer server keeps a long-lived WebSocket connection, so the
host has to run a persistent Node process rather than short-lived functions.

## Adding your cats

1. Put 5 square photos in `public/assets/cats/` named `cat1.png` … `cat5.png`.
2. (Optional) Open `server/cards.js` and change the `name` of each cat in the
   `CATS` array to their real names.

The game is fully playable before you add photos — cards just show a placeholder.

## The deck (balanced, 56 cards)

| Card | In-game name | Count | Effect |
|------|--------------|-------|--------|
| Exploding | Exploding Cat | 4 (uses players−1) | Draw it and you're out, unless defused |
| Defuse | Catnip | 6 | Survive an Exploding Cat; reinsert it secretly |
| Nope | Hiss | 5 | Cancel another player's action; can be re-hissed |
| Attack | Pounce | 4 | End your turn; next player takes 2 turns |
| Skip | Scamper | 4 | End your turn without drawing |
| Favor | Beg | 4 | A chosen player gives you a card |
| Shuffle | Knock It Off The Table | 4 | Shuffle the draw pile |
| See the Future | Curious Peek | 5 | Privately view the top 3 cards |
| Cat (×5 types) | your cats | 4 each = 20 | Pairs steal a random card; trios demand a named card |

## How to play

- On your turn, play as many cards as you like, then **draw** to end your turn
  (or play **Scamper**/**Pounce** to end without drawing).
- Drawing an **Exploding Cat** knocks you out — unless you hold **Catnip**, which
  lets you sneak the cat back into the deck wherever you choose.
- Any player can **Hiss** to cancel an action while its 5-second window is open;
  a second Hiss cancels the cancel.
- Last cat standing wins.

## Project layout

```
server/
  index.js    Express + Socket.IO server and event wiring
  rooms.js    Lobby / room management and pending-action timers
  game.js     Authoritative game state, setup, snapshots
  actions.js  All move logic (play, hiss, draw, defuse, favor, future)
  cards.js    Card catalogue — edit CATS here for your cats' names
public/
  index.html  Screens: home, lobby, game table
  styles.css  Styling
  client.js   Front-end game client
  assets/cats Your cat photos go here
```
