import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
const worker = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
const env = { EVENT_HQ_ORIGIN: 'https://event-hq.example' };

function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = original; });
}

test('HQ API proxy is HTTPS-only, route-limited, and strips ambient credentials', async () => {
  let captured;
  await withFetch(async request => {
    captured = request;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'upstream=secret', Server: 'hidden' },
    });
  }, async () => {
    const response = await worker.fetch(new Request('https://junkyardolympics.com/hq-api/api/cannon/runs/run-1/teams/team-1/arm?view=full', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer opaque-host-token',
        'Content-Type': 'application/json',
        Cookie: 'browser=session',
        Origin: 'https://evil.example',
        'X-Forwarded-For': 'attacker-controlled',
        'X-Junkyard-User-Name': 'Mallory',
      },
      body: JSON.stringify({ clear: true }),
    }), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('server'), null);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });
  assert.equal(captured.url, 'https://event-hq.example/api/cannon/runs/run-1/teams/team-1/arm?view=full');
  assert.equal(captured.method, 'POST');
  assert.equal(captured.headers.get('authorization'), 'Bearer opaque-host-token');
  assert.equal(captured.headers.get('content-type'), 'application/json');
  for (const header of ['cookie', 'origin', 'x-forwarded-for', 'x-junkyard-user-name']) assert.equal(captured.headers.get(header), null, header);
  assert.equal(await captured.text(), JSON.stringify({ clear: true }));
});

test('HQ API proxy rejects unlisted paths and methods without contacting upstream', async () => {
  let calls = 0;
  await withFetch(async () => { calls += 1; return new Response('unexpected'); }, async () => {
    assert.equal((await worker.fetch(new Request('https://junkyardolympics.com/hq-api/api/organizer/export'), env)).status, 404);
    assert.equal((await worker.fetch(new Request('https://junkyardolympics.com/hq-api/api/cannon/setup', { method: 'PATCH' }), env)).status, 405);
    assert.equal((await worker.fetch(new Request('https://evil.example/hq-api/api/state'), env)).status, 404);
  });
  assert.equal(calls, 0);
});

test('dedicated HQ host preserves approved organizer mutations and rejects broad proxying', async () => {
  let captured;
  await withFetch(async request => {
    captured = request;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }, async () => {
    const response = await worker.fetch(new Request('https://hq.junkyardolympics.com/api/organizer/photos/photo-1/delete', {
      method: 'POST',
      headers: { Authorization: 'Bearer opaque-host-token', 'Content-Type': 'application/json', Cookie: 'ambient=drop-me' },
      body: JSON.stringify({ confirmed: true }),
    }), env);
    assert.equal(response.status, 200);
  });
  assert.equal(captured.url, 'https://event-hq.example/api/organizer/photos/photo-1/delete');
  assert.equal(captured.method, 'POST');
  assert.equal(captured.headers.get('authorization'), 'Bearer opaque-host-token');
  assert.equal(captured.headers.get('cookie'), null);
  assert.equal(await captured.text(), JSON.stringify({ confirmed: true }));

  let calls = 0;
  await withFetch(async () => { calls += 1; return new Response('unexpected'); }, async () => {
    assert.equal((await worker.fetch(new Request('https://hq.junkyardolympics.com/api/organizer/database/raw'), env)).status, 404);
    assert.equal((await worker.fetch(new Request('https://hq.junkyardolympics.com/admin', { method: 'POST' }), env)).status, 405);
  });
  assert.equal(calls, 0);
});

test('published photo descriptor reaches Event HQ with its exact version query', async () => {
  let captured;
  await withFetch(async request => {
    captured = request;
    return new Response('photo-bytes', { status: 200, headers: { 'Content-Type': 'image/webp' } });
  }, async () => {
    const response = await worker.fetch(new Request('https://junkyardolympics.com/hq-api/api/photo-wall/photos/photo-1/image?version=abc123'), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
  });
  assert.equal(captured.url, 'https://event-hq.example/api/photo-wall/photos/photo-1/image?version=abc123');
  assert.equal(captured.method, 'GET');
});

test('HQ API proxy fails closed without an exact HTTPS origin', async () => {
  for (const origin of [undefined, 'http://relay.example:8880', 'https://user:pass@hq.example', 'https://hq.example/path']) {
    let calls = 0;
    await withFetch(async () => { calls += 1; return new Response('unexpected'); }, async () => {
      const response = await worker.fetch(new Request('https://junkyardolympics.com/hq-api/api/state'), { EVENT_HQ_ORIGIN: origin });
      assert.equal(response.status, 503, String(origin));
    });
    assert.equal(calls, 0, String(origin));
  }
});
