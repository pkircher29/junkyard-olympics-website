/* Junkyard Olympics Music — party jukebox worker (music.junkyardolympics.com)
   Deployed as `junkyard-music` on Cloudflare, sharing the bracket-attack D1 db.

   - Guests join with a username + the shared party password.
   - Spotify search proxied via the client-credentials flow.
   - Requests enter a weighted round-robin queue: users with fewer songs
     played go first; >10 requests in 2 minutes = 20-minute ban and the
     offender's rotation slot is pushed to the end of the line.
   - Host player console links a Spotify Premium account (OAuth) and plays
     via the Web Playback SDK; when the queue is empty, autoplay picks from
     the last played track's artist top-tracks (Spotify retired the
     recommendations endpoint for new apps).

   Static frontend is proxied from this repo's main branch /music folder,
   same pattern as the bracket app worker. */

const GH = 'https://raw.githubusercontent.com/pkircher29/Bracket-attack-/main/music';
const TYPES = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8', json: 'application/json',
  png: 'image/png', svg: 'image/svg+xml', ico: 'image/x-icon',
};
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

const RATE_WINDOW_MS = 2 * 60 * 1000;   // two minutes
const RATE_MAX = 10;                    // more than ten requests -> ban
const BAN_MS = 20 * 60 * 1000;          // twenty-minute rejection
const REPEAT_WINDOW_MS = 2 * 60 * 60 * 1000;  // same song max once per 2 hours

let schemaReady = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS music_config (k TEXT PRIMARY KEY, v TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS music_users (
      id TEXT PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE, token TEXT,
      created TEXT, played INTEGER NOT NULL DEFAULT 0,
      penalty INTEGER NOT NULL DEFAULT 0, banned_until TEXT,
      role TEXT NOT NULL DEFAULT 'guest')`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS music_requests (
      id TEXT PRIMARY KEY, user_id TEXT, source TEXT NOT NULL DEFAULT 'guest',
      track_id TEXT, track TEXT, status TEXT NOT NULL DEFAULT 'queued',
      requested_at TEXT, played_at TEXT)`),
  ]);
  // migration for tables created before the role column existed
  try { await env.DB.prepare("ALTER TABLE music_users ADD COLUMN role TEXT NOT NULL DEFAULT 'guest'").run(); } catch {}
  schemaReady = true;
}

async function cfg(env) {
  const rows = await env.DB.prepare('SELECT k, v FROM music_config').all();
  return Object.fromEntries((rows.results || []).map(r => [r.k, r.v]));
}

async function setCfg(env, obj) {
  const stmts = Object.entries(obj).map(([k, v]) =>
    env.DB.prepare('INSERT INTO music_config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .bind(k, v == null ? '' : String(v)));
  if (stmts.length) await env.DB.batch(stmts);
}

async function getUser(env, req) {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : new URL(req.url).searchParams.get('token');
  if (!token) return null;
  return env.DB.prepare('SELECT * FROM music_users WHERE token = ?').bind(token).first();
}

/* ---------- Spotify auth ---------- */

function accountsBase(c) { return c.accounts_base || 'https://accounts.spotify.com'; }
function apiBase(c) { return c.api_base || 'https://api.spotify.com'; }

async function tokenRequest(c, params) {
  const res = await fetch(`${accountsBase(c)}/api/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${c.spotify_client_id}:${c.spotify_client_secret}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
  return res.json();
}

// app-only token: enough for search + artist top-tracks
async function clientToken(env, c) {
  if (c.cc_token && Number(c.cc_expires) > Date.now() + 10000) return c.cc_token;
  const d = await tokenRequest(c, { grant_type: 'client_credentials' });
  if (!d.access_token) throw new Error('spotify auth failed: ' + JSON.stringify(d));
  await setCfg(env, { cc_token: d.access_token, cc_expires: String(Date.now() + (d.expires_in || 3600) * 1000) });
  return d.access_token;
}

// host account token: needed by the Web Playback SDK on the player console
async function hostToken(env, c) {
  if (!c.spotify_refresh_token) return null;
  if (c.ht_token && Number(c.ht_expires) > Date.now() + 10000) return c.ht_token;
  const d = await tokenRequest(c, { grant_type: 'refresh_token', refresh_token: c.spotify_refresh_token });
  if (!d.access_token) return null;
  const save = { ht_token: d.access_token, ht_expires: String(Date.now() + (d.expires_in || 3600) * 1000) };
  if (d.refresh_token) save.spotify_refresh_token = d.refresh_token;
  await setCfg(env, save);
  return d.access_token;
}

function slimTrack(t) {
  return {
    id: t.id, uri: t.uri, name: t.name,
    artists: (t.artists || []).map(a => ({ id: a.id, name: a.name })),
    album: (t.album && t.album.name) || '',
    album_id: (t.album && t.album.id) || '',
    year: ((t.album && t.album.release_date) || '').slice(0, 4),
    popularity: t.popularity ?? 0,
    art: (t.album && t.album.images && (t.album.images[1] || t.album.images[0]) || {}).url || '',
    duration_ms: t.duration_ms || 0,
  };
}

function slimAlbum(a) {
  return {
    id: a.id, name: a.name,
    artists: (a.artists || []).map(x => ({ id: x.id, name: x.name })),
    year: (a.release_date || '').slice(0, 4),
    art: ((a.images && (a.images[1] || a.images[0])) || {}).url || '',
    total_tracks: a.total_tracks || 0,
  };
}

/* ---------- queue engine ---------- */

// Weighted round-robin: users ordered by (played + penalty), ties broken by
// who has been waiting longest. Simulates forward to produce the full order.
async function queueOrder(env) {
  const users = (await env.DB.prepare('SELECT * FROM music_users').all()).results || [];
  const reqs = (await env.DB.prepare(
    "SELECT * FROM music_requests WHERE status = 'queued' ORDER BY requested_at").all()).results || [];
  const byUser = new Map();
  for (const r of reqs) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r);
  }
  const sim = users
    .filter(u => byUser.has(u.id))
    .map(u => ({ u, key: u.played + u.penalty, q: byUser.get(u.id) }));
  const order = [];
  while (sim.some(s => s.q.length)) {
    sim.sort((a, b) =>
      (a.key - b.key) ||
      ((a.q[0] ? a.q[0].requested_at : '~') < (b.q[0] ? b.q[0].requested_at : '~') ? -1 : 1));
    const top = sim.find(s => s.q.length);
    const r = top.q.shift();
    top.key += 1;
    order.push({ id: r.id, user_id: r.user_id, user_name: top.u.name, track: JSON.parse(r.track), requested_at: r.requested_at });
  }
  return { order, users };
}

/* ---------- request handler ---------- */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      if (p.startsWith('/api/') || p.startsWith('/spotify/')) {
        await ensureSchema(env);
        return await api(req, env, url, p);
      }
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }

    /* static frontend from the repo's /music folder */
    if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'method not allowed' }, 405);
    let path = p === '/' || p === '' ? '/index.html' : p;
    if (path.includes('..')) return new Response('Not found', { status: 404 });
    const upstream = await fetch(GH + path, { cf: { cacheTtl: 120, cacheEverything: true } });
    if (!upstream.ok) return new Response('Not found', { status: 404 });
    const ext = path.split('.').pop().toLowerCase();
    return new Response(upstream.body, {
      headers: { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=60' },
    });
  },
};

async function api(req, env, url, p) {
  const c = await cfg(env);
  const now = Date.now();
  const iso = (t = now) => new Date(t).toISOString();

  /* ----- setup & status ----- */

  if (p === '/api/status' && req.method === 'GET') {
    return json({
      configured: !!c.shared_password,
      spotify: !!(c.spotify_client_id && c.spotify_client_secret),
      linked: !!c.spotify_refresh_token,
      redirect_uri: `${url.origin}/spotify/callback`,
    });
  }

  if (p === '/api/setup' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    if (c.shared_password && b.current_password !== c.shared_password) {
      return json({ error: 'wrong current party password' }, 403);
    }
    const save = {};
    for (const k of ['shared_password', 'host_password', 'host_names', 'spotify_client_id', 'spotify_client_secret', 'spotify_refresh_token', 'accounts_base', 'api_base']) {
      if (b[k] != null && b[k] !== '') save[k] = String(b[k]).trim();
    }
    if (save.spotify_client_id || save.spotify_client_secret) { save.cc_token = ''; save.cc_expires = '0'; }
    if (save.spotify_refresh_token) { save.ht_token = ''; save.ht_expires = '0'; }
    await setCfg(env, save);
    return json({ ok: true });
  }

  /* ----- Spotify account linking (host) ----- */

  if (p === '/spotify/login') {
    if (!c.spotify_client_id) return json({ error: 'set up Spotify credentials first' }, 400);
    const q = new URLSearchParams({
      client_id: c.spotify_client_id,
      response_type: 'code',
      redirect_uri: `${url.origin}/spotify/callback`,
      scope: 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state user-library-read',
    });
    return Response.redirect(`${accountsBase(c)}/authorize?${q}`, 302);
  }

  if (p === '/spotify/callback') {
    const code = url.searchParams.get('code');
    const err = url.searchParams.get('error');
    // bare visit (no code, no error): someone opened the callback directly —
    // just send them to the console
    if (!code && !err) return Response.redirect(`${url.origin}/#/player`, 302);
    if (!code) return new Response('Spotify said no: ' + err, { status: 400 });
    const d = await tokenRequest(c, {
      grant_type: 'authorization_code', code, redirect_uri: `${url.origin}/spotify/callback`,
    });
    if (!d.refresh_token) return new Response('Token exchange failed: ' + JSON.stringify(d), { status: 400 });
    await setCfg(env, {
      spotify_refresh_token: d.refresh_token,
      ht_token: d.access_token || '', ht_expires: String(Date.now() + (d.expires_in || 3600) * 1000),
    });
    return Response.redirect(`${url.origin}/#/player`, 302);
  }

  /* ----- guest auth ----- */

  if (p === '/api/join' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    if (!c.shared_password) return json({ error: 'not set up yet — visit /#/setup' }, 400);
    const name = String(b.name || '').trim().slice(0, 24);
    if (name.length < 2) return json({ error: 'name too short' }, 400);

    // Two passwords: the shared party password logs in guests; the host
    // password unlocks the admin console, but ONLY for the allow-listed host
    // names. The first UUID created for each host name is the admin identity
    // forever — guests can't claim a host name, and no new admins can appear.
    const hostNames = JSON.parse(c.host_names || '[]').map(n => n.toLowerCase());
    const isHostPw = !!c.host_password && (b.password || '') === c.host_password;
    const isGuestPw = (b.password || '') === c.shared_password;
    if (!isHostPw && !isGuestPw) return json({ error: 'wrong party password' }, 403);

    const token = crypto.randomUUID();
    const existing = await env.DB.prepare('SELECT * FROM music_users WHERE name = ?').bind(name).first();
    let user;

    if (isHostPw) {
      if (!hostNames.includes(name.toLowerCase())) {
        return json({ error: 'the host password only works for host accounts' }, 403);
      }
      if (existing) {
        await env.DB.prepare("UPDATE music_users SET token = ?, role = 'host' WHERE id = ?").bind(token, existing.id).run();
        user = { ...existing, token, role: 'host' };
      } else {
        user = { id: crypto.randomUUID(), name, token, created: iso(), role: 'host' };
        await env.DB.prepare("INSERT INTO music_users (id, name, token, created, role) VALUES (?, ?, ?, ?, 'host')")
          .bind(user.id, name, token, user.created).run();
      }
    } else {
      if (existing && existing.role === 'host') {
        return json({ error: 'that name is a host account — use the host password' }, 403);
      }
      if (existing) {
        await env.DB.prepare('UPDATE music_users SET token = ? WHERE id = ?').bind(token, existing.id).run();
        user = { ...existing, token };
      } else {
        user = { id: crypto.randomUUID(), name, token, created: iso(), role: 'guest' };
        await env.DB.prepare('INSERT INTO music_users (id, name, token, created) VALUES (?, ?, ?, ?)')
          .bind(user.id, name, token, user.created).run();
      }
    }
    return json({ token, user: { id: user.id, name: user.name, role: user.role || 'guest' } });
  }

  const user = await getUser(env, req);
  if (!user) return json({ error: 'not logged in' }, 401);

  /* ----- search ----- */

  if (p === '/api/search' && req.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    if (q.length < 2) return json({ tracks: [] });
    // Dev-mode Spotify apps cap /v1/search at limit=10 — anything higher gets
    // a 400 "Invalid limit". Prefer the host user token; app-only fallback.
    const tok = (await hostToken(env, c)) || (await clientToken(env, c));
    const res = await fetch(`${apiBase(c)}/v1/search?` + new URLSearchParams({ q, type: 'track', limit: '10', market: 'US' }),
      { headers: { Authorization: 'Bearer ' + tok } });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.tracks) {
      // don't swallow Spotify errors as "no matches"
      const msg = (d.error && d.error.message) || `Spotify search failed (HTTP ${res.status})`;
      return json({ error: msg, spotify_status: res.status }, 502);
    }
    return json({ tracks: (d.tracks.items || []).map(slimTrack) });
  }

  /* ----- album & artist browsing ----- */

  // Full track list for one album. GET /v1/albums/{id} is not restricted for
  // dev-mode apps and inlines up to 50 tracks.
  if (p === '/api/album' && req.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    if (!/^[A-Za-z0-9]+$/.test(id)) return json({ error: 'bad album id' }, 400);
    const tok = (await hostToken(env, c)) || (await clientToken(env, c));
    const res = await fetch(`${apiBase(c)}/v1/albums/${id}?market=US`,
      { headers: { Authorization: 'Bearer ' + tok } });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.id) {
      const msg = (d.error && d.error.message) || `Spotify album lookup failed (HTTP ${res.status})`;
      return json({ error: msg, spotify_status: res.status }, 502);
    }
    const album = slimAlbum(d);
    let items = (d.tracks && d.tracks.items) || [];
    if ((d.tracks && d.tracks.total) > items.length) {
      const more = await (await fetch(`${apiBase(c)}/v1/albums/${id}/tracks?limit=50&offset=50&market=US`,
        { headers: { Authorization: 'Bearer ' + tok } })).json();
      items = items.concat(more.items || []);
    }
    // album track objects are "simple" (no album/popularity) — fill in from the album
    const tracks = items.map(t => ({
      ...slimTrack(t), album: album.name, album_id: album.id, year: album.year, art: album.art,
    }));
    return json({ album, tracks });
  }

  // An artist's popular tracks + catalog. /v1/artists/{id}/top-tracks and
  // /albums are blocked for dev-mode apps, but filtered search works and
  // paginates, so build the catalog from artist:"name" queries.
  if (p === '/api/artist' && req.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    const name = (url.searchParams.get('name') || '').slice(0, 100);
    if (!/^[A-Za-z0-9]+$/.test(id) || !name) return json({ error: 'bad artist id/name' }, 400);
    const tok = (await hostToken(env, c)) || (await clientToken(env, c));
    const H = { Authorization: 'Bearer ' + tok };
    const search = async (type, offset) => {
      const r = await fetch(`${apiBase(c)}/v1/search?` + new URLSearchParams({
        q: `artist:"${name.replace(/"/g, '')}"`, type, limit: '10', offset: String(offset), market: 'US',
      }), { headers: H });
      const d = await r.json().catch(() => ({}));
      return (d[type + 's'] && d[type + 's'].items) || [];
    };
    const [topTracks, ...albumPages] = await Promise.all([
      search('track', 0), search('album', 0), search('album', 10), search('album', 20),
    ]);
    const mine = x => (x.artists || []).some(a => a.id === id);
    const seen = new Set();
    const albums = albumPages.flat().filter(mine).filter(a => !seen.has(a.id) && seen.add(a.id))
      .map(slimAlbum).sort((a, b) => (b.year || '') < (a.year || '') ? -1 : 1);
    const tracks = topTracks.filter(mine).map(slimTrack)
      .sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    return json({ artist: { id, name }, tracks, albums });
  }

  /* ----- requests ----- */

  if (p === '/api/request' && req.method === 'POST') {
    if (user.banned_until && user.banned_until > iso()) {
      return json({ error: 'banned', banned_until: user.banned_until }, 429);
    }
    const b = await req.json().catch(() => ({}));
    if (!b.track || !b.track.id) return json({ error: 'missing track' }, 400);

    // one spin per song per 2 hours: block if this track is already queued or
    // was played (by request OR autoplay) inside the window
    const repeatStart = iso(now - REPEAT_WINDOW_MS);
    const dup = await env.DB.prepare(
      "SELECT status FROM music_requests WHERE track_id = ? AND (status = 'queued' OR (status = 'played' AND played_at > ?)) LIMIT 1")
      .bind(b.track.id, repeatStart).first();
    if (dup) {
      return json({
        error: dup.status === 'queued'
          ? 'that song is already in the queue 🔁'
          : 'that song already played recently — one spin per 2 hours, pick something fresh 🔁',
      }, 409);
    }

    const windowStart = iso(now - RATE_WINDOW_MS);
    const cnt = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM music_requests WHERE user_id = ? AND source = 'guest' AND requested_at > ?")
      .bind(user.id, windowStart).first();
    if ((cnt.n || 0) >= RATE_MAX) {
      const bannedUntil = iso(now + BAN_MS);
      const maxKey = await env.DB.prepare('SELECT MAX(played + penalty) AS m FROM music_users').first();
      const penalty = Math.max(0, (maxKey.m || 0) + 1 - user.played);
      await env.DB.prepare('UPDATE music_users SET banned_until = ?, penalty = ? WHERE id = ?')
        .bind(bannedUntil, penalty, user.id).run();
      await env.DB.prepare(
        'INSERT INTO music_requests (id, user_id, source, track_id, track, status, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), user.id, 'guest', b.track.id, JSON.stringify(b.track), 'rejected', iso()).run();
      return json({ error: 'slow down! banned for 20 minutes and sent to the back of the line', banned: true, banned_until: bannedUntil }, 429);
    }

    await env.DB.prepare(
      'INSERT INTO music_requests (id, user_id, source, track_id, track, status, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), user.id, 'guest', b.track.id, JSON.stringify(b.track), 'queued', iso()).run();
    const { order } = await queueOrder(env);
    const position = order.findIndex(o => o.user_id === user.id && o.track.id === b.track.id) + 1;
    return json({ ok: true, position: position || order.length });
  }

  if (p.startsWith('/api/request/') && req.method === 'DELETE') {
    const id = p.split('/').pop();
    await env.DB.prepare("UPDATE music_requests SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'queued'")
      .bind(id, user.id).run();
    return json({ ok: true });
  }

  /* ----- queue view ----- */

  if (p === '/api/queue' && req.method === 'GET') {
    const { order, users } = await queueOrder(env);
    return json({
      now_playing: c.np_track ? { track: JSON.parse(c.np_track), started: c.np_started, source: c.np_source || 'request', user_name: c.np_user || '' } : null,
      up_next: order.map((o, i) => ({ pos: i + 1, id: o.id, user_name: o.user_name, track: o.track, mine: o.user_id === user.id })),
      users: users
        .filter(u => u.played > 0 || order.some(o => o.user_id === u.id) || (u.banned_until && u.banned_until > iso()))
        .map(u => ({ name: u.name, played: u.played, role: u.role || 'guest', banned: !!(u.banned_until && u.banned_until > iso()) })),
      me: { id: user.id, name: user.name, role: user.role || 'guest', played: user.played, banned_until: (user.banned_until && user.banned_until > iso()) ? user.banned_until : null },
    });
  }

  /* ----- host-only: player console + admin actions ----- */

  if (p === '/api/next' || p === '/api/played' || p === '/api/spotify/token' || p.startsWith('/api/admin/')) {
    if ((user.role || 'guest') !== 'host') return json({ error: 'hosts only' }, 403);
  }

  if (p.startsWith('/api/admin/request/') && req.method === 'DELETE') {
    const id = p.split('/').pop();
    await env.DB.prepare("UPDATE music_requests SET status = 'cancelled' WHERE id = ? AND status = 'queued'").bind(id).run();
    return json({ ok: true });
  }

  if (p === '/api/admin/unban' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    if (!b.name) return json({ error: 'missing name' }, 400);
    await env.DB.prepare('UPDATE music_users SET banned_until = NULL, penalty = 0 WHERE name = ?').bind(String(b.name)).run();
    return json({ ok: true });
  }

  // permanent ban: locks the guest out of requesting and clears their queue
  if (p === '/api/admin/ban' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    if (!b.name) return json({ error: 'missing name' }, 400);
    const target = await env.DB.prepare('SELECT * FROM music_users WHERE name = ?').bind(String(b.name)).first();
    if (!target) return json({ error: 'no such guest' }, 404);
    if ((target.role || 'guest') === 'host') return json({ error: 'cannot ban a host' }, 400);
    await env.DB.prepare("UPDATE music_users SET banned_until = '9999-12-31T00:00:00.000Z' WHERE id = ?").bind(target.id).run();
    await env.DB.prepare("UPDATE music_requests SET status = 'cancelled' WHERE user_id = ? AND status = 'queued'").bind(target.id).run();
    return json({ ok: true });
  }

  if (p === '/api/next' && req.method === 'GET') {
    const { order } = await queueOrder(env);
    if (order.length) {
      const o = order[0];
      return json({ source: 'request', request_id: o.id, user_name: o.user_name, track: o.track });
    }

    const recent = (await env.DB.prepare(
      "SELECT track_id FROM music_requests WHERE status = 'played' ORDER BY played_at DESC LIMIT 30").all())
      .results.map(r => r.track_id);
    const last = c.np_track ? JSON.parse(c.np_track) : null;
    const pickFrom = (tracks) => {
      const slim = tracks.map(slimTrack);
      const pool = slim.filter(t => !recent.includes(t.id) && (!last || t.id !== last.id));
      return pool.length ? pool[Math.floor(Math.random() * pool.length)]
        : slim.filter(t => !last || t.id !== last.id)[0] || null;
    };

    // autoplay: default to a random pick from the host's Liked Songs
    const ht = await hostToken(env, c);
    if (ht) {
      const first = await (await fetch(`${apiBase(c)}/v1/me/tracks?limit=1`,
        { headers: { Authorization: 'Bearer ' + ht } })).json();
      const total = first.total || 0;
      if (total > 0) {
        const offset = Math.floor(Math.random() * Math.max(1, total - 49));
        const page = await (await fetch(`${apiBase(c)}/v1/me/tracks?limit=50&offset=${offset}`,
          { headers: { Authorization: 'Bearer ' + ht } })).json();
        const pick = pickFrom((page.items || []).map(i => i.track).filter(Boolean));
        if (pick) return json({ source: 'auto', track: pick, via: 'liked' });
      }
    }

    // fallback: top tracks by the last played track's lead artist
    const artistId = last && last.artists && last.artists[0] && last.artists[0].id;
    if (!artistId) return json({ source: 'none' });
    // same dev-mode catalog restriction as search: prefer the host token
    const tok = ht || (await clientToken(env, c));
    const d = await (await fetch(`${apiBase(c)}/v1/artists/${artistId}/top-tracks?market=US`,
      { headers: { Authorization: 'Bearer ' + tok } })).json();
    const pick = pickFrom(d.tracks || []);
    if (!pick) return json({ source: 'none' });
    return json({ source: 'auto', track: pick, via: 'artist' });
  }

  if (p === '/api/played' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    let track = b.track, source = 'auto', userName = '';
    if (b.request_id) {
      const r = await env.DB.prepare('SELECT * FROM music_requests WHERE id = ?').bind(b.request_id).first();
      if (r && r.status === 'queued') {
        await env.DB.prepare("UPDATE music_requests SET status = 'played', played_at = ? WHERE id = ?").bind(iso(), r.id).run();
        await env.DB.prepare('UPDATE music_users SET played = played + 1 WHERE id = ?').bind(r.user_id).run();
        const owner = await env.DB.prepare('SELECT name FROM music_users WHERE id = ?').bind(r.user_id).first();
        track = JSON.parse(r.track); source = 'request'; userName = owner ? owner.name : '';
      }
    } else if (track && track.id) {
      await env.DB.prepare(
        'INSERT INTO music_requests (id, user_id, source, track_id, track, status, requested_at, played_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), 'auto', track.id, JSON.stringify(track), 'played', iso(), iso()).run();
    }
    if (track) await setCfg(env, { np_track: JSON.stringify(track), np_started: iso(), np_source: source, np_user: userName });
    return json({ ok: true });
  }

  if (p === '/api/spotify/token' && req.method === 'GET') {
    const tok = await hostToken(env, c);
    if (!tok) return json({ error: 'spotify not linked — visit /spotify/login from the host device' }, 400);
    return json({ access_token: tok });
  }

  return json({ error: 'not found' }, 404);
}
