/* Junkyard Jukebox — guest request app + host player console */
'use strict';

const API = localStorage.getItem('jm-api') || '';   // same origin in production
const $ = (s, el = document) => el.querySelector(s);

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = msg;
  $('#toasts').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, 4500);
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const token = localStorage.getItem('jm-token');
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(API + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { localStorage.removeItem('jm-token'); location.hash = '#/login'; }
  if (!res.ok) throw Object.assign(new Error(data.error || 'request failed'), { status: res.status, data });
  return data;
}

const loggedIn = () => !!localStorage.getItem('jm-token');
const myName = () => localStorage.getItem('jm-name') || '';
const isHost = () => localStorage.getItem('jm-role') === 'host';

/* ---- shared session cookie: one login for both junkyardolympics.com sites ---- */

function writeSharedCookie() {
  const v = encodeURIComponent(JSON.stringify({
    token: localStorage.getItem('jm-token'),
    name: localStorage.getItem('jm-name'),
    role: localStorage.getItem('jm-role') || 'guest',
  }));
  const base = `jo_auth=${v}; path=/; max-age=604800; SameSite=Lax`;
  document.cookie = base;
  if (location.hostname.endsWith('junkyardolympics.com')) {
    document.cookie = base + '; domain=.junkyardolympics.com';
  }
}

function clearSharedCookie() {
  document.cookie = 'jo_auth=; path=/; max-age=0';
  if (location.hostname.endsWith('junkyardolympics.com')) {
    document.cookie = 'jo_auth=; path=/; max-age=0; domain=.junkyardolympics.com';
  }
}

// adopt a session created on the bracket site
(() => {
  if (loggedIn()) return;
  const m = document.cookie.match(/(?:^|;\s*)jo_auth=([^;]+)/);
  if (!m) return;
  try {
    const s = JSON.parse(decodeURIComponent(m[1]));
    if (s && s.token) {
      localStorage.setItem('jm-token', s.token);
      localStorage.setItem('jm-name', s.name || '');
      localStorage.setItem('jm-role', s.role || 'guest');
    }
  } catch {}
})();

/* ---------- views ---------- */

let pollTimer = null;

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function art(t, cls = '') {
  return t.art ? `<img src="${esc(t.art)}" alt="" loading="lazy">` : `<div class="noart ${cls}">🎵</div>`;
}

function artistLinks(artists) {
  return (artists || []).map(a => a.id
    ? `<a class="mlink" href="#/artist/${esc(a.id)}/${encodeURIComponent(a.name)}">${esc(a.name)}</a>`
    : esc(a.name)).join(', ');
}

function trackMeta(t) {
  const album = t.album_id
    ? `<a class="mlink" href="#/album/${esc(t.album_id)}">${esc(t.album)}</a>`
    : esc(t.album);
  return `${artistLinks(t.artists)} · ${album}${t.year ? ` · ${esc(t.year)}` : ''}`;
}

function vLogin() {
  return `
  <div class="login">
    <img class="heroart" src="https://junkyardolympics.com/assets/junkyard-hero.jpg" alt="">
    <div class="hero-stripe"></div>
    <h1>Junkyard <em>Jukebox</em></h1>
    <p class="muted">You pick it, we blast it. Fair rotation, no hogging the aux.</p>
    <input id="l-name" placeholder="Your name" maxlength="24" autocomplete="off">
    <input id="l-pass" type="password" placeholder="Party password" autocomplete="off">
    <button class="btn btn-accent btn-lg" data-action="join">🎶 Let me in</button>
    <p class="muted small">Looking for the scoreboard? <a href="https://junkyardolympics.com" style="color:var(--accent)">🏆 junkyardolympics.com</a></p>
  </div>`;
}

// QR-link landing (same code as the bracket site's poster): name only.
function vJoinLink(code) {
  return `
  <div class="login">
    <img class="heroart" src="https://junkyardolympics.com/assets/junkyard-hero.jpg" alt="">
    <div class="hero-stripe"></div>
    <h1>Junkyard <em>Jukebox</em></h1>
    <p class="muted">You scanned the poster — what do we call you?</p>
    <input id="jl-name" placeholder="Your name" maxlength="24" autocomplete="off">
    <button class="btn btn-accent btn-lg" data-action="join-link" data-code="${esc(code)}">🔥 I'm in</button>
    <p class="muted small">No password needed — your phone remembers you all day.</p>
  </div>`;
}

function vSearch() {
  return `
  <h2>Request a song</h2>
  <input id="q" placeholder="Search songs, artists, albums…" autocomplete="off">
  <div id="results" style="margin-top:14px"><div class="empty">Type to search Spotify. 🔍</div></div>`;
}

const reqBtn = i => `<button class="btn btn-accent btn-sm" data-action="req" data-i="${i}">＋ Request</button>`;

function vAlbum(d) {
  const a = d.album;
  return `
  <a class="mlink small" href="#" data-action="back">← Back</a>
  <div class="card nowplaying" style="margin-top:10px">
    ${art(a)}
    <div class="tinfo">
      <div class="tname">${esc(a.name)}</div>
      <div class="tmeta">${artistLinks(a.artists)}${a.year ? ` · ${esc(a.year)}` : ''} · ${a.total_tracks} tracks</div>
    </div>
  </div>
  <h2 style="margin-top:18px">Tracks</h2>
  <div id="results">${d.tracks.map((t, i) => trackRow(t, reqBtn(i))).join('')}</div>`;
}

function vArtist(d) {
  return `
  <a class="mlink small" href="#" data-action="back">← Back</a>
  <h2 style="margin-top:10px">${esc(d.artist.name)}</h2>
  <h2>Popular tracks</h2>
  <div id="results">${d.tracks.length
    ? d.tracks.map((t, i) => trackRow(t, reqBtn(i))).join('')
    : '<div class="empty">No tracks found.</div>'}</div>
  <h2>Albums & singles</h2>
  ${d.albums.length ? `<div class="albumgrid">
    ${d.albums.map(al => `
    <a class="albumcard" href="#/album/${esc(al.id)}">
      ${art(al)}
      <div class="aname">${esc(al.name)}</div>
      <div class="muted small">${esc(al.year)}${al.total_tracks > 1 ? ` · ${al.total_tracks} tracks` : ''}</div>
    </a>`).join('')}
  </div>` : '<div class="empty">No albums found.</div>'}`;
}

function trackRow(t, action) {
  const pop = Math.max(0, Math.min(100, t.popularity || 0));
  return `
  <div class="trackrow">
    ${art(t)}
    <div class="tinfo">
      <div class="tname">${esc(t.name)}</div>
      <div class="tmeta">${trackMeta(t)} · ${fmtDur(t.duration_ms)}</div>
      <div class="pop"><div class="popbar"><i style="width:${pop}%"></i></div><span class="muted small">${pop}</span></div>
    </div>
    ${action || ''}
  </div>`;
}

function vQueue(d) {
  const np = d.now_playing;
  const banned = d.me.banned_until;
  return `
  ${banned ? (new Date(banned).getFullYear() > 9000
    ? `<div class="banbox"><b>⛔ Banned.</b> The host has cut you off from requests. Go plead your case in person.</div>`
    : `<div class="banbox"><b>⛔ Cooling off.</b> You fired off too many requests — you're on a
     20-minute timeout and your spot moved to the back of the line.
     <span class="muted small">Back at ${new Date(banned).toLocaleTimeString()}.</span></div>`) : ''}
  <h2>Now playing</h2>
  ${np ? `<div class="card nowplaying">
      ${art(np.track)}
      <div class="tinfo">
        <div class="tname">${esc(np.track.name)}</div>
        <div class="tmeta">${trackMeta(np.track)}</div>
        <div style="margin-top:6px">${np.source === 'auto'
          ? '<span class="chip chip-auto">🤖 autoplay</span>'
          : `<span class="chip chip-live"><span class="pulse"></span>requested by ${esc(np.user_name || '?')}</span>`}</div>
      </div>
    </div>`
    : `<div class="empty">Nothing spinning yet — <a href="#/search" style="color:var(--accent)">request something!</a></div>`}
  <h2>Up next <span class="muted small">(fair rotation — fewest plays goes first)</span></h2>
  ${d.up_next.length ? d.up_next.map(o => `
    <div class="trackrow ${o.mine ? 'mine' : ''}">
      <div class="tpos">${o.pos}</div>
      ${art(o.track)}
      <div class="tinfo">
        <div class="tname">${esc(o.track.name)}</div>
        <div class="tmeta">${trackMeta(o.track)} — <b>${esc(o.user_name)}</b></div>
      </div>
      ${o.mine ? `<button class="btn btn-ghost btn-sm" data-action="cancel" data-id="${o.id}">✕</button>`
        : (isHost() ? `<button class="btn btn-ghost btn-sm" title="remove (host)" data-action="admin-del" data-id="${o.id}">🎛✕</button>` : '')}
    </div>`).join('')
    : `<div class="empty">Queue's empty — autoplay keeps the tunes going, but your pick beats the robot's. 🤖</div>`}
  <h2>Plays so far</h2>
  <div class="statchips">
    ${d.users.length ? d.users.map(u =>
      `<span class="pchip">${esc(u.name)} <b>${u.played}</b>${u.banned ? ' ⛔' : ''}${u.role === 'host' ? ' 🎛' : ''}
       ${u.banned && isHost() ? `<button class="btn btn-ghost btn-sm" data-action="unban" data-name="${esc(u.name)}">unban</button>` : ''}
       ${!u.banned && u.role !== 'host' && isHost() ? `<button class="btn btn-ghost btn-sm" title="permanently ban" data-action="ban" data-name="${esc(u.name)}">ban</button>` : ''}</span>`).join('')
      : '<span class="muted small">No plays yet.</span>'}
  </div>`;
}

function vPlayer() {
  return `
  <h2>Host player console</h2>
  <div class="card playerbox" id="playerbox">
    <div class="muted">Checking Spotify link…</div>
  </div>
  <p class="muted small" style="margin-top:12px">This page plays the music — open it on the device wired to the
  speakers (Spotify Premium required). It auto-advances the queue and falls back to autoplay when empty.
  &nbsp;·&nbsp; <a href="#/setup" style="color:var(--accent)">⚙ Setup</a></p>`;
}

function vSetup(st) {
  return `
  <h2>Host setup</h2>
  <div class="card">
    <p class="muted small" style="margin-bottom:12px">
      Create a (free) Spotify app at <b>developer.spotify.com/dashboard</b>, add
      <b>${esc(st.redirect_uri)}</b> as a Redirect URI, then paste its credentials here.
      Web Playback SDK requires Spotify Premium on the host account.
    </p>
    ${st.configured ? `<label class="f">Current party password (to make changes)<input id="s-cur" type="password"></label>` : ''}
    <label class="f">Party password (what guests type to get in)<input id="s-pass" placeholder="e.g. scrapyard2026"></label>
    <label class="f">Spotify Client ID<input id="s-id" placeholder="${st.spotify ? 'saved ✓ (leave blank to keep)' : ''}"></label>
    <label class="f">Spotify Client Secret<input id="s-secret" type="password" placeholder="${st.spotify ? 'saved ✓ (leave blank to keep)' : ''}"></label>
    <button class="btn btn-accent" data-action="save-setup">Save</button>
    <p class="muted small" style="margin-top:10px">
      Status: password ${st.configured ? '✓' : '✗'} · Spotify app ${st.spotify ? '✓' : '✗'} ·
      host account ${st.linked ? 'linked ✓' : `not linked — <a href="${API}/spotify/login" style="color:var(--accent)">connect Spotify</a> (after saving)`}
    </p>
  </div>`;
}

/* ---------- router ---------- */

function nav() {
  const r = location.hash.replace(/^#\//, '') || 'search';
  const games = `<a href="https://junkyardolympics.com" title="Junkyard Olympics scoreboard">🏆 Games</a>`;
  $('#nav').innerHTML = loggedIn() ? `
    ${games}
    <a href="#/search" class="${r === 'search' ? 'on' : ''}">Search</a>
    <a href="#/queue" class="${r === 'queue' ? 'on' : ''}">Queue</a>
    ${isHost() ? `<a href="#/player" class="${r === 'player' ? 'on' : ''}">🎛 Admin</a>` : ''}
    <a href="#/login" data-action="logout" title="${esc(myName())}">↩</a>` : games;
}

async function render() {
  clearInterval(pollTimer);
  const r = location.hash.replace(/^#\//, '') || (loggedIn() ? 'search' : 'login');
  nav();
  const app = $('#app');

  if (r.startsWith('join/')) {
    if (loggedIn()) { location.hash = '#/search'; return; }
    app.innerHTML = vJoinLink(r.slice(5));
    const n = $('#jl-name'); if (n) n.focus();
    return;
  }
  if (r === 'setup') {
    const st = await api('/api/status');
    // setup lives in the admin menu; open only for hosts (or first-run bootstrap)
    if (st.configured && !isHost()) {
      app.innerHTML = '<div class="empty">🎛 Hosts only.</div>';
      return;
    }
    app.innerHTML = vSetup(st);
    return;
  }
  if (!loggedIn() || r === 'login') { app.innerHTML = vLogin(); return; }

  if (r === 'queue') {
    const load = async () => {
      try { app.innerHTML = vQueue(await api('/api/queue')); } catch {}
    };
    await load();
    pollTimer = setInterval(load, 4000);
    return;
  }
  if (r === 'player') {
    if (!isHost()) { app.innerHTML = '<div class="empty">🎛 Hosts only. Log in with the host password to run the show.</div>'; return; }
    app.innerHTML = vPlayer();
    Player.init();
    return;
  }
  if (r.startsWith('album/')) {
    const id = r.split('/')[1] || '';
    app.innerHTML = '<div class="empty">Loading album… 💿</div>';
    try {
      const d = await api('/api/album?id=' + encodeURIComponent(id));
      app.innerHTML = vAlbum(d);
      $('#results').dataset.tracks = JSON.stringify(d.tracks);
    } catch (e) { app.innerHTML = `<div class="empty">Couldn't load that album: ${esc(e.message)}</div>`; }
    return;
  }
  if (r.startsWith('artist/')) {
    const seg = r.split('/');
    const id = seg[1] || '';
    const name = decodeURIComponent(seg.slice(2).join('/') || '');
    app.innerHTML = '<div class="empty">Loading artist… 🎤</div>';
    try {
      const d = await api('/api/artist?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(name));
      app.innerHTML = vArtist(d);
      $('#results').dataset.tracks = JSON.stringify(d.tracks);
    } catch (e) { app.innerHTML = `<div class="empty">Couldn't load that artist: ${esc(e.message)}</div>`; }
    return;
  }
  app.innerHTML = vSearch();
  const q = $('#q');
  let t = null;
  q.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(doSearch, 400);
  });
  q.focus();
}

async function doSearch() {
  const q = $('#q');
  const box = $('#results');
  if (!q || q.value.trim().length < 2) { if (box) box.innerHTML = '<div class="empty">Type to search Spotify. 🔍</div>'; return; }
  try {
    const d = await api('/api/search?q=' + encodeURIComponent(q.value.trim()));
    box.innerHTML = d.tracks.length
      ? d.tracks.map((t, i) => trackRow(t, `<button class="btn btn-accent btn-sm" data-action="req" data-i="${i}">＋ Request</button>`)).join('')
      : '<div class="empty">No matches. Try another search.</div>';
    box.dataset.tracks = JSON.stringify(d.tracks);
  } catch (e) {
    box.innerHTML = `<div class="empty">Search failed: ${esc(e.message)}</div>`;
  }
}

/* ---------- host player ---------- */

const Player = (() => {
  let player = null, deviceId = null, current = null, advancing = false, kicked = false;
  let watchTimer = null, lastPos = 0;

  function box() { return $('#playerbox'); }

  async function init() {
    try {
      const st = await api('/api/status');
      if (!st.spotify) { box().innerHTML = `<div>Spotify app not configured. <a class="btn btn-accent btn-sm" href="#/setup">Go to setup</a></div>`; return; }
      if (!st.linked) { box().innerHTML = `<div><a class="btn btn-accent" href="${API}/spotify/login">🔗 Connect host Spotify (Premium)</a></div>`; return; }
      await api('/api/spotify/token'); // verifies the link works
      // re-entering the page must NOT spawn a second player/device — reuse
      if (player) { ui(deviceId ? (current ? 'Playing.' : 'Ready — hit Start to fire it up.') : 'Connecting to Spotify…'); return; }
      loadSdk();
    } catch (e) {
      box().innerHTML = `<div class="muted">Player error: ${esc(e.message)}</div>`;
    }
  }

  function loadSdk() {
    if (window.Spotify) return onSdk();
    window.onSpotifyWebPlaybackSDKReady = onSdk;
    const s = document.createElement('script');
    s.src = 'https://sdk.scdn.co/spotify-player.js';
    document.head.appendChild(s);
    box().innerHTML = '<div class="muted">Loading Spotify player…</div>';
  }

  function onSdk() {
    player = new Spotify.Player({
      name: 'Junkyard Jukebox 📻',
      getOAuthToken: cb => api('/api/spotify/token').then(d => cb(d.access_token)).catch(() => {}),
      volume: 1,
    });
    player.addListener('ready', e => { deviceId = e.device_id; ui('Ready — hit Start to fire it up.'); });
    player.addListener('not_ready', () => ui('Device went offline.'));
    player.addListener('initialization_error', e => ui('Init error: ' + e.message));
    player.addListener('authentication_error', e => ui('Auth error: ' + e.message));
    player.addListener('account_error', () => ui('This Spotify account is not Premium — playback needs Premium.'));
    player.addListener('player_state_changed', st => {
      if (!st) return;
      if (current && st.paused && st.position === 0 &&
          st.track_window.previous_tracks.some(t => t.id === current.trackId)) {
        trackEnded();
      }
    });
    player.connect();
    startWatch();
    ui('Connecting to Spotify…');
  }

  // Watchdog poll — the player_state_changed heuristic misses track end when
  // playing single URIs (previous_tracks stays empty), which strands the
  // console in silence. Poll the SDK state instead:
  //  - track was progressing, now paused at 0:00 -> it ended, advance
  //  - an autoplay track is on and a real request arrives -> fade into it
  function startWatch() {
    clearInterval(watchTimer);
    watchTimer = setInterval(async () => {
      if (advancing || !deviceId || !player) return;
      try {
        const st = await player.getCurrentState();
        if (current && st) {
          if (st.paused && st.position === 0 && lastPos > 1000) {
            lastPos = 0; current = null;
            return playNext();
          }
          if (!st.paused) lastPos = st.position;
        }
        if (current && current.source === 'auto') {
          const n = await api('/api/next');
          if (n.source === 'request' && !advancing) return fadeInto();
        }
      } catch {}
    }, 3000);
  }

  // requests beat the robot: ramp the volume down, advance, ramp back up
  async function fadeInto() {
    try { for (let v = 9; v >= 0; v--) { await player.setVolume(v / 10); await new Promise(r => setTimeout(r, 110)); } } catch {}
    lastPos = 0; current = null;
    await playNext();
    try { for (let v = 2; v <= 10; v++) { await player.setVolume(v / 10); await new Promise(r => setTimeout(r, 70)); } } catch {}
  }

  function ui(status) {
    const npHtml = current ? `
      <div class="nowplaying" style="text-align:left">
        ${art(current.track)}
        <div class="tinfo">
          <div class="tname">${esc(current.track.name)}</div>
          <div class="tmeta">${trackMeta(current.track)}</div>
          <div style="margin-top:6px">${current.source === 'auto'
            ? '<span class="chip chip-auto">🤖 autoplay</span>'
            : `<span class="chip chip-live"><span class="pulse"></span>${esc(current.userName || 'request')}</span>`}</div>
        </div>
      </div>` : '';
    box().innerHTML = `
      ${npHtml}
      <div class="muted small">${esc(status)}</div>
      <div class="controls">
        <button class="btn btn-accent" data-action="p-start">▶ ${current ? 'Next' : 'Start'}</button>
        <button class="btn btn-ghost" data-action="p-toggle">⏯ Pause/Resume</button>
        <button class="btn btn-ghost" data-action="p-skip">⏭ Skip</button>
      </div>`;
  }

  async function playNext() {
    if (advancing || !deviceId) return;
    advancing = true;
    try {
      const n = await api('/api/next');
      if (n.source === 'none') { ui('Queue empty and nothing played yet — get a request in to start the party.'); return; }
      const track = n.track;
      const tok = (await api('/api/spotify/token')).access_token;
      const res = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uris: [track.uri] }),
      });
      if (!res.ok && res.status !== 204) throw new Error('Spotify play failed (' + res.status + ')');
      lastPos = 0;
      current = { track, trackId: track.id, source: n.source, userName: n.user_name };
      await api('/api/played', { method: 'POST', body: JSON.stringify(n.source === 'request' ? { request_id: n.request_id } : { track }) });
      if (!kicked) {
        // SDK quirk: the first play on a fresh device can report "playing"
        // while sitting silent at 0:00 — a pause/resume over the Web API
        // unsticks it. Only needed once per page load.
        kicked = true;
        await new Promise(r => setTimeout(r, 800));
        const st = await Promise.race([player.getCurrentState(), new Promise(r => setTimeout(() => r(null), 1500))]);
        if (!st || st.position === 0) {
          const H = { Authorization: 'Bearer ' + tok };
          await fetch('https://api.spotify.com/v1/me/player/pause', { method: 'PUT', headers: H });
          await new Promise(r => setTimeout(r, 300));
          await fetch('https://api.spotify.com/v1/me/player/play', { method: 'PUT', headers: H });
        }
      }
      ui('Playing.');
    } catch (e) {
      ui('Play error: ' + e.message);
    } finally {
      // never leave the advancing latch stuck — a jammed latch bricked Skip
      advancing = false;
    }
  }

  function trackEnded() {
    current = null;
    lastPos = 0;
    playNext();
  }

  return {
    init, playNext,
    toggle: () => player && player.togglePlay(),
    skip: () => { playNext(); },
  };
})();

/* ---------- actions ---------- */

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const act = el.dataset.action;
  try {
    if (act === 'join') {
      const name = $('#l-name').value.trim();
      const pass = $('#l-pass').value;
      const d = await api('/api/join', { method: 'POST', body: JSON.stringify({ name, password: pass }) });
      localStorage.setItem('jm-token', d.token);
      localStorage.setItem('jm-name', d.user.name);
      localStorage.setItem('jm-role', d.user.role || 'guest');
      writeSharedCookie();
      toast(d.user.role === 'host' ? `🎛 Host console unlocked — welcome, <b>${esc(d.user.name)}</b>!`
        : `Welcome, <b>${esc(d.user.name)}</b>! 🎶`);
      location.hash = d.user.role === 'host' ? '#/player' : '#/search';
    }
    if (act === 'logout') { localStorage.removeItem('jm-token'); localStorage.removeItem('jm-role'); clearSharedCookie(); }
    if (act === 'back') { e.preventDefault(); history.length > 1 ? history.back() : (location.hash = '#/search'); }
    if (act === 'join-link') {
      const name = $('#jl-name').value.trim();
      if (!name) { toast('Type your name first!', 'error'); return; }
      let pass = '';
      try { pass = decodeURIComponent(escape(atob(decodeURIComponent(el.dataset.code || '')))); } catch {}
      if (!pass) { toast('This signup link is broken — grab the host.', 'error'); return; }
      const d = await api('/api/join', { method: 'POST', body: JSON.stringify({ name, password: pass }) });
      localStorage.setItem('jm-token', d.token);
      localStorage.setItem('jm-name', d.user.name);
      localStorage.setItem('jm-role', d.user.role || 'guest');
      writeSharedCookie();
      toast(`Welcome, <b>${esc(d.user.name)}</b>! 🎶`);
      location.hash = '#/search';
    }
    if (act === 'req') {
      const tracks = JSON.parse($('#results').dataset.tracks || '[]');
      const t = tracks[Number(el.dataset.i)];
      if (!t) return;
      el.disabled = true;
      const d = await api('/api/request', { method: 'POST', body: JSON.stringify({ track: t }) });
      toast(`Queued <b>${esc(t.name)}</b> — position ${d.position} in the rotation. 🎶`);
    }
    if (act === 'cancel') {
      await api('/api/request/' + el.dataset.id, { method: 'DELETE' });
      toast('Request cancelled.');
      render();
    }
    if (act === 'admin-del') {
      await api('/api/admin/request/' + el.dataset.id, { method: 'DELETE' });
      toast('Request removed. 🎛');
      render();
    }
    if (act === 'unban') {
      await api('/api/admin/unban', { method: 'POST', body: JSON.stringify({ name: el.dataset.name }) });
      toast(`${esc(el.dataset.name)} unbanned and restored in the rotation. 🎛`);
      render();
    }
    if (act === 'ban') {
      if (!confirm(`Permanently ban ${el.dataset.name} from requesting? Their queued songs are removed too.`)) return;
      await api('/api/admin/ban', { method: 'POST', body: JSON.stringify({ name: el.dataset.name }) });
      toast(`${esc(el.dataset.name)} is permanently banned. ⛔`);
      render();
    }
    if (act === 'save-setup') {
      const body = {
        current_password: $('#s-cur') ? $('#s-cur').value : '',
        shared_password: $('#s-pass').value,
        spotify_client_id: $('#s-id').value,
        spotify_client_secret: $('#s-secret').value,
      };
      await api('/api/setup', { method: 'POST', body: JSON.stringify(body) });
      toast('Saved. ✓');
      render();
    }
    if (act === 'p-start') Player.playNext();
    if (act === 'p-toggle') Player.toggle();
    if (act === 'p-skip') Player.skip();
  } catch (err) {
    if (err.status === 429 && err.data && err.data.banned_until) {
      const perma = new Date(err.data.banned_until).getFullYear() > 9000;
      toast(perma ? '⛔ The host has banned you from requesting.'
        : `⛔ ${esc(err.message)}<br><span class="small">You can request again at ${new Date(err.data.banned_until).toLocaleTimeString()}.</span>`, 'error');
      if (location.hash.includes('queue')) render();
    } else {
      toast(esc(err.message), 'error');
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && $('#l-pass') && document.activeElement === $('#l-pass')) {
    const btn = $('[data-action="join"]');
    if (btn) btn.click();
  }
  if (e.key === 'Enter' && $('#jl-name') && document.activeElement === $('#jl-name')) {
    const btn = $('[data-action="join-link"]');
    if (btn) btn.click();
  }
});

addEventListener('hashchange', render);
render();
