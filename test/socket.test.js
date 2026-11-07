'use strict';
// Malformed socket payloads must not crash the server (socket.io runs handlers
// in process.nextTick, so a throw there is an uncaught exception).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');

const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;

async function waitForPing(tries = 50) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(`${BASE}/api/ping`)).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test('bad socket payloads get an error ack, the server stays up, good ones still work', async (t) => {
  const env = { ...process.env, PORT: String(PORT), KV_REST_API_URL: '', KV_REST_API_TOKEN: '',
    UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', RENDER_EXTERNAL_URL: '' };
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env, stdio: 'ignore' });
  t.after(() => server.kill());
  assert.ok(await waitForPing(), 'server did not start');

  // Raw socket.io v4 protocol: "40" connects the default namespace, "42<id>[...]" is an event with an ack id.
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/socket.io/?EIO=4&transport=websocket`);
  const acks = new Map();
  ws.on('message', (m) => {
    const s = m.toString();
    if (s === '2') ws.send('3'); // heartbeat
    if (s.startsWith('40')) ws.emit('ready');
    const ack = /^43(\d+)(.*)$/.exec(s);
    if (ack) acks.set(Number(ack[1]), JSON.parse(ack[2])[0]);
  });
  await new Promise((r) => ws.once('open', () => { ws.send('40'); ws.once('ready', r); }));
  t.after(() => ws.close());

  const bad = [['createRoom', null], ['joinRoom'], ['createRoom', { name: 42, playerId: 'x' }], ['react', 'str'], ['createRoom', { name: ' Ann ', playerId: 'p1' }]];
  bad.forEach((args, i) => ws.send(`42${i}${JSON.stringify(args)}`));
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(server.exitCode, null, 'server process exited');
  assert.ok(await waitForPing(5), 'server stopped answering');
  assert.equal(acks.get(0)?.ok, false, 'no error ack for a null payload');
  assert.equal(acks.get(2)?.ok, false, 'no error ack for a non-string name');
  assert.equal(acks.get(4)?.ok, true, 'a valid createRoom was rejected');
  assert.match(acks.get(4).code, /^[A-Z0-9]+$/);
});
