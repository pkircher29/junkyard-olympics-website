import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workerSource = await readFile(new URL('./music-worker.js', import.meta.url), 'utf8');
const worker = (await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`)).default;

const aliceTrack = {
  id: 'spotify-secret-track-id-1',
  uri: 'spotify:track:secret-1',
  name: 'Safe Song',
  artists: [{ id: 'artist-secret-1', name: 'The Welders' }],
  album: 'Scrap Metal Hits',
  album_id: 'album-secret-1',
  art: 'https://images.example/safe-song.jpg',
  duration_ms: 183000,
  popularity: 99,
  token: 'track-level-secret',
};
const bobTrack = {
  id: 'spotify-secret-track-id-2',
  uri: 'spotify:track:secret-2',
  name: 'Next Safe Song',
  artists: [{ id: 'artist-secret-2', name: 'Rust Orchestra' }],
  album: 'Yard Anthems',
  album_id: 'album-secret-2',
  art: 'https://images.example/next-safe-song.jpg',
  duration_ms: 204000,
};

function makeEnv() {
  const users = [
    { id: 'user-secret-alice', name: 'Alice Requester', token: 'alice-token-secret', played: 0, penalty: 0, role: 'guest', banned_until: null },
    { id: 'user-secret-bob', name: 'Bob Requester', token: 'bob-token-secret', played: 1, penalty: 0, role: 'guest', banned_until: null },
    { id: 'user-host-paul', name: 'Paul Host', token: 'paul-host-token-secret', played: 0, penalty: 0, role: 'host', banned_until: null },
  ];
  const requests = [
    { id: 'request-secret-alice', user_id: users[0].id, track: JSON.stringify(aliceTrack), status: 'queued', requested_at: '2026-08-15T18:01:00.000Z' },
    { id: 'request-secret-bob', user_id: users[1].id, track: JSON.stringify(bobTrack), status: 'queued', requested_at: '2026-08-15T18:00:00.000Z' },
  ];
  const config = {
    shared_password: 'party-password-secret',
    spotify_client_secret: 'spotify-client-secret',
    np_track: JSON.stringify(bobTrack),
    np_started: '2026-08-15T18:02:00.000Z',
    np_source: 'request',
    np_user: 'Bob Requester',
  };

  const DB = {
    prepare(sql) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      let binds = [];
      return {
        bind(...values) { binds = values; return this; },
        async all() {
          if (normalized === 'SELECT k, v FROM music_config') {
            return { results: Object.entries(config).map(([k, v]) => ({ k, v })) };
          }
          if (normalized === 'SELECT * FROM music_users') return { results: users.map(user => ({ ...user })) };
          if (normalized.includes("FROM music_requests WHERE status = 'queued'")) {
            return { results: requests.map(request => ({ ...request })) };
          }
          throw new Error(`Unexpected all(): ${normalized}`);
        },
        async first() {
          if (normalized === 'SELECT * FROM music_users WHERE token = ?') {
            return users.find(user => user.token === binds[0]) || null;
          }
          throw new Error(`Unexpected first(): ${normalized}`);
        },
        async run() { return { success: true }; },
      };
    },
    async batch() { return []; },
  };

  return { DB };
}

async function request(path, { method = 'GET', token } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  return worker.fetch(new Request(`https://music.example${path}`, { method, headers }), makeEnv());
}

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) value.forEach(item => collectKeys(item, keys));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

test('GET /api/public/queue is unauthenticated, CORS-enabled, and exposes only TV-safe projections', async () => {
  const response = await request('/api/public/queue');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await response.json(), {
    now_playing: {
      pos: 0,
      track: {
        name: 'Next Safe Song',
        artists: [{ name: 'Rust Orchestra' }],
        album: 'Yard Anthems',
        art: 'https://images.example/next-safe-song.jpg',
        duration_ms: 204000,
      },
    },
    up_next: [
      {
        pos: 1,
        track: {
          name: 'Safe Song',
          artists: [{ name: 'The Welders' }],
          album: 'Scrap Metal Hits',
          art: 'https://images.example/safe-song.jpg',
          duration_ms: 183000,
        },
      },
      {
        pos: 2,
        track: {
          name: 'Next Safe Song',
          artists: [{ name: 'Rust Orchestra' }],
          album: 'Yard Anthems',
          art: 'https://images.example/next-safe-song.jpg',
          duration_ms: 204000,
        },
      },
    ],
  });

  const payload = await (await request('/api/public/queue')).json();
  const forbidden = /^(?:id|user_id|user_name|request_id|token|users|user|me|mine|controls?|source|started|uri|album_id|popularity)$/i;
  assert.deepEqual(collectKeys(payload).filter(key => forbidden.test(key)), []);
  const serialized = JSON.stringify(payload);
  for (const secret of ['Alice Requester', 'Bob Requester', 'user-secret-', 'request-secret-', 'token-secret', 'spotify-secret-']) {
    assert.equal(serialized.includes(secret), false, `public payload leaked ${secret}`);
  }
});

test('/api/public/queue is GET-only', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await request('/api/public/queue', { method });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('allow'), 'GET', method);
    assert.equal(response.headers.get('access-control-allow-origin'), '*', method);
    assert.deepEqual(await response.json(), { error: 'method not allowed' }, method);
  }
});

test('authenticated GET /api/queue retains its existing response contract', async () => {
  const response = await request('/api/queue', { token: 'alice-token-secret' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    now_playing: { track: bobTrack, started: '2026-08-15T18:02:00.000Z', source: 'request', user_name: 'Bob Requester' },
    up_next: [
      { pos: 1, id: 'request-secret-alice', user_name: 'Alice Requester', track: aliceTrack, mine: true },
      { pos: 2, id: 'request-secret-bob', user_name: 'Bob Requester', track: bobTrack, mine: false },
    ],
    users: [
      { name: 'Alice Requester', played: 0, role: 'guest', banned: false },
      { name: 'Bob Requester', played: 1, role: 'guest', banned: false },
    ],
    me: { id: 'user-secret-alice', name: 'Alice Requester', role: 'guest', played: 0, banned_until: null },
  });
});

test('GET /api/session returns only the authoritative bounded identity for a valid bearer', async () => {
  const response = await request('/api/session', { token: 'paul-host-token-secret' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { user: { id: 'user-host-paul', name: 'Paul Host', role: 'host' } });
  const invalid = await request('/api/session', { token: 'revoked-or-unknown' });
  assert.equal(invalid.status, 401);
  assert.deepEqual(await invalid.json(), { error: 'not logged in' });
});

test('/api/session is GET-only', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await request('/api/session', { method, token: 'paul-host-token-secret' });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('allow'), 'GET', method);
    assert.deepEqual(await response.json(), { error: 'method not allowed' }, method);
  }
});
