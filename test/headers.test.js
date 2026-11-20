'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 20000 + Math.floor(Math.random() * 20000);

test('responses carry baseline security headers and no X-Powered-By', async (t) => {
  const env = { ...process.env, PORT: String(PORT), KV_REST_API_URL: '', KV_REST_API_TOKEN: '',
    UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', RENDER_EXTERNAL_URL: '' };
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env, stdio: 'ignore' });
  t.after(() => server.kill());
  for (const url of ['/api/ping', '/']) {
    let res;
    for (let i = 0; i < 50 && !res; i++) {
      try { res = await fetch(`http://127.0.0.1:${PORT}${url}`); } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.ok(res?.ok, `${url} did not respond`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(res.headers.get('x-powered-by'), null);
  }
});
