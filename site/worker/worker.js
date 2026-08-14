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
