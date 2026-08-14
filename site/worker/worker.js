/* Bracket Attack worker (deployed as `bracket-attack-sync` on Cloudflare).
   Serves BOTH:
     - the sync API: room-based JSON store on D1
     - the app itself: static files proxied from this repo's `main` branch
       on raw.githubusercontent.com with edge caching, so merging to main
       updates the live site within ~2 minutes, no redeploy needed.

   Routed to junkyardolympics.com/* and www.junkyardolympics.com/*
   (Cloudflare zone worker routes), also reachable at
   bracket-attack-sync.pkircher.workers.dev.

   API:
     GET /r/:room?since=N -> { version, state } (or { version, unchanged: true })
     PUT /r/:room  body { state } -> { version }

   D1 schema:
     CREATE TABLE rooms (id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0,
                         state TEXT NOT NULL, updated TEXT);

   Redeploy with: npx wrangler deploy worker/worker.js --name bracket-attack-sync
   (bind the D1 database as `DB`). */

const GH = 'https://raw.githubusercontent.com/pkircher29/Bracket-attack-/main';
const TYPES = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  md: 'text/plain; charset=utf-8',
};

/* The MAIN SITE (junkyardolympics.com) is Chris's control tower — his full
   app, proxied over the tailnet bridge:
     guest -> this worker -> VPS relay (relay.junkyardolympics.com:8880,
     socat) -> tailnet -> RecRoomRig:8790 (Node/SQLite server).
   Paul's bracket scoreboard lives on bracket.junkyardolympics.com (static
   files from this repo). The sync API (/r/:room) answers on every host. */
const HQ_ORIGIN = 'http://relay.junkyardolympics.com:8880';
const HQ_HOSTS = ['hq.junkyardolympics.com'];

function hqDownPage() {
  return new Response(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Junkyard Olympics</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  font-family:'Courier New',monospace;background:#f1e3c1;color:#171814;text-align:center;padding:20px">
<div style="max-width:440px;border:3px solid #171814;background:#faf3e0;box-shadow:6px 6px 0 rgba(23,24,20,.8);padding:26px">
  <h1 style="font-family:Impact,'Arial Narrow',sans-serif;letter-spacing:.02em;margin:0 0 8px">JUNKYARD OLYMPICS</h1>
  <p style="font-weight:700;text-transform:uppercase;font-size:.8rem;letter-spacing:.1em;color:#a73520">control tower offline</p>
  <p>The event server isn't reachable right now. The rest of the yard still works:</p>
  <p style="margin-top:14px">
    <a href="https://bracket.junkyardolympics.com" style="display:inline-block;border:2px solid #171814;background:#e65f1a;color:#171814;font-weight:700;padding:10px 16px;text-decoration:none;box-shadow:3px 3px 0 rgba(23,24,20,.8)">🏆 Scoreboard</a>
    <a href="https://music.junkyardolympics.com" style="display:inline-block;border:2px solid #171814;background:#faf3e0;color:#171814;font-weight:700;padding:10px 16px;text-decoration:none;box-shadow:3px 3px 0 rgba(23,24,20,.8)">🎶 Jukebox</a>
  </p>
</div></body></html>`, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Content-Type': 'application/json',
    };
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/r\/([a-zA-Z0-9_-]{1,64})$/);

    // Chris's app on the main domain — every path except the sync API
    if (!m && HQ_HOSTS.includes(url.hostname)) {
      try {
        const upstream = await fetch(new Request(HQ_ORIGIN + url.pathname + url.search, req));
        // network failures surface as synthetic Cloudflare 52x responses
        if (upstream.status >= 520 && upstream.status <= 530) return hqDownPage();
        const headers = new Headers(upstream.headers);
        if (url.pathname.startsWith('/api/')) headers.set('Access-Control-Allow-Origin', '*');
        const out = new Response(upstream.body, { status: upstream.status, headers });
        // yard bar: link the jukebox + bracket scoreboard from every HQ page
        if (upstream.ok && (headers.get('content-type') || '').includes('text/html')) {
          const bar = `<div style="position:fixed;bottom:10px;right:10px;z-index:9999;display:flex;gap:8px;font-family:'Courier New',monospace">
            <a href="https://music.junkyardolympics.com" style="background:#171814;color:#f1e3c1;border:2px solid #000;box-shadow:3px 3px 0 rgba(0,0,0,.5);padding:8px 12px;font-weight:700;font-size:12px;letter-spacing:.06em;text-decoration:none">🎶 JUKEBOX</a>
            <a href="https://bracket.junkyardolympics.com" style="background:#171814;color:#f1e3c1;border:2px solid #000;box-shadow:3px 3px 0 rgba(0,0,0,.5);padding:8px 12px;font-weight:700;font-size:12px;letter-spacing:.06em;text-decoration:none">🏆 BRACKETS</a>
          </div>`;
          return new HTMLRewriter()
            .on('body', { element(el) { el.append(bar, { html: true }); } })
            .transform(out);
        }
        return out;
      } catch (e) {
        return hqDownPage();
      }
    }

    /* ---------- sync API ---------- */
    if (m) {
      const room = m[1].toLowerCase();
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

      if (req.method === 'GET') {
        const row = await env.DB.prepare('SELECT version, state FROM rooms WHERE id = ?').bind(room).first();
        if (!row) return new Response(JSON.stringify({ version: 0, state: null }), { headers: cors });
        const since = Number(url.searchParams.get('since') || -1);
        if (since >= row.version) {
          return new Response(JSON.stringify({ version: row.version, unchanged: true }), { headers: cors });
        }
        return new Response(JSON.stringify({ version: row.version, state: JSON.parse(row.state) }), { headers: cors });
      }

      if (req.method === 'PUT') {
        // Writes require a valid party login (token from the jukebox user db —
        // one login works on both sites). Reads stay open. If the jukebox is
        // not configured yet, writes stay open too (bootstrap/dev).
        try {
          const pw = await env.DB.prepare("SELECT v FROM music_config WHERE k = 'shared_password'").first();
          if (pw && pw.v) {
            const auth = req.headers.get('Authorization') || '';
            const tok = auth.startsWith('Bearer ') ? auth.slice(7) : null;
            const u = tok ? await env.DB.prepare('SELECT id FROM music_users WHERE token = ?').bind(tok).first() : null;
            if (!u) return new Response(JSON.stringify({ error: 'login required' }), { status: 401, headers: cors });
          }
        } catch (e) { /* music tables absent -> open */ }
        let body;
        try { body = await req.json(); } catch {
          return new Response(JSON.stringify({ error: 'bad json' }), { status: 400, headers: cors });
        }
        if (!body || typeof body.state !== 'object' || body.state === null) {
          return new Response(JSON.stringify({ error: 'missing state' }), { status: 400, headers: cors });
        }
        const text = JSON.stringify(body.state);
        if (text.length > 900000) {
          return new Response(JSON.stringify({ error: 'state too large' }), { status: 413, headers: cors });
        }
        const row = await env.DB.prepare(
          `INSERT INTO rooms (id, version, state, updated) VALUES (?, 1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET version = version + 1, state = excluded.state, updated = excluded.updated
           RETURNING version`
        ).bind(room, text, new Date().toISOString()).first();
        return new Response(JSON.stringify({ version: row.version }), { headers: cors });
      }

      return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers: cors });
    }

    /* ---------- static app (proxied from the GitHub repo's main branch) ---------- */
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers: cors });
    }
    let p = url.pathname;
    if (p === '/' || p === '') p = '/index.html';
    if (p.includes('..')) return new Response('Not found', { status: 404 });
    const upstream = await fetch(GH + p, { cf: { cacheTtl: 120, cacheEverything: true } });
    if (!upstream.ok) return new Response('Not found', { status: 404 });
    const ext = p.split('.').pop().toLowerCase();
    return new Response(upstream.body, {
      headers: {
        'Content-Type': TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=60',
      },
    });
  },
};
