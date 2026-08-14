/* Bracket Attack — multi-device live sync.
   All devices in the same "room" share one scoreboard through a tiny
   Cloudflare Worker (see worker/ in this repo). Sync is merge-based:
   - tournaments merge per-match by last-write-wins timestamps
   - deletions travel as tombstones
   - the bracket is reconciled after every merge, so two phones can
     score different matches of the same tournament at once. */
'use strict';

const Sync = (() => {
  // When the app is served by the sync worker itself (junkyardolympics.com
  // or workers.dev), the API lives on the same origin. Anywhere else
  // (GitHub Pages, local file) we talk to the worker cross-origin.
  const SAME_ORIGIN = /(^|\.)junkyardolympics\.com$|\.workers\.dev$/i.test(location.hostname);
  const DEFAULT_URL = SAME_ORIGIN ? '' : 'https://bracket-attack-sync.pkircher.workers.dev';

  const url = localStorage.getItem('ba-sync-url') || DEFAULT_URL;
  let room = (localStorage.getItem('ba-room') || 'junkyard').toLowerCase();
  let enabled = localStorage.getItem('ba-sync-enabled') !== '0';

  let version = 0;          // last server version we've seen
  let lastRemoteText = '';  // JSON of the server state at that version
  let status = enabled ? 'connecting' : 'off';
  let pushTimer = null;
  let busy = false;

  /* ---------- merge machinery ---------- */

  const clone = (x) => JSON.parse(JSON.stringify(x));
  const newer = (a, b) => ((a && a.updatedAt) || '') >= ((b && b.updatedAt) || '');

  function mergeDeleted(a = {}, b = {}) {
    const out = { players: {}, staticTeams: {}, tournaments: {} };
    for (const k of Object.keys(out)) {
      const A = a[k] || {}, B = b[k] || {};
      for (const id of new Set([...Object.keys(A), ...Object.keys(B)])) {
        out[k][id] = (A[id] || '') > (B[id] || '') ? A[id] : B[id];
      }
    }
    return out;
  }

  // union of two item lists by id; local order first, remote-only appended
  function mergeColl(localList, remoteList, tombs, mergeItem) {
    const out = [];
    const remoteById = new Map(remoteList.map(x => [x.id, x]));
    const seen = new Set();
    const keep = (item) => {
      const ts = tombs[item.id];
      return !ts || ((item.updatedAt || '') > ts);
    };
    for (const l of localList) {
      seen.add(l.id);
      const r = remoteById.get(l.id);
      const item = r ? (mergeItem ? mergeItem(l, r) : (newer(l, r) ? l : r)) : l;
      if (keep(item)) out.push(item);
    }
    for (const r of remoteList) {
      if (!seen.has(r.id) && keep(r)) out.push(r);
    }
    return out;
  }

  function mergeStates(remote, local) {
    if (!remote) return local;
    if (!local) return remote;
    const deleted = mergeDeleted(remote.deleted, local.deleted);
    return {
      players: mergeColl(local.players || [], remote.players || [], deleted.players),
      staticTeams: mergeColl(local.staticTeams || [], remote.staticTeams || [], deleted.staticTeams),
      tournaments: mergeColl(local.tournaments || [], remote.tournaments || [],
        deleted.tournaments, (l, r) => Bracket.mergeTournaments(l, r)),
      settings: newer(local.settings, remote.settings) ? (local.settings || {}) : (remote.settings || {}),
      signups: mergeColl(local.signups || [], remote.signups || [], {}),
      deleted,
    };
  }

  /* ---------- transport ---------- */

  async function fetchRoom(since) {
    const res = await fetch(`${url}/r/${encodeURIComponent(room)}?since=${since}`);
    if (!res.ok) throw new Error('sync fetch failed');
    return res.json();
  }

  async function putRoom(state) {
    const auth = (typeof Auth !== 'undefined' && Auth.token) ? { Authorization: 'Bearer ' + Auth.token } : {};
    const res = await fetch(`${url}/r/${encodeURIComponent(room)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ state }),
    });
    if (!res.ok) throw new Error('sync push failed');
    return res.json();
  }

  /* One cycle: pull remote, merge with local, adopt merged locally,
     and push back up if we hold anything the server doesn't. */
  async function cycle() {
    if (!enabled || busy) return;
    busy = true;
    try {
      const r = await fetchRoom(version);
      let remoteState;
      if (r.unchanged) {
        remoteState = lastRemoteText ? JSON.parse(lastRemoteText) : null;
      } else {
        remoteState = r.state;
        lastRemoteText = remoteState ? JSON.stringify(remoteState) : '';
      }
      version = r.version;

      const merged = mergeStates(remoteState, Store.state);
      const mergedText = JSON.stringify(merged);

      if (mergedText !== JSON.stringify(Store.state)) {
        Store.replace(merged);            // remote had news for us
        if (window.App) App.rerender();
      }
      if (mergedText !== (lastRemoteText || JSON.stringify(null))) {
        const res = await putRoom(merged); // we had news for the room
        version = res.version;
        lastRemoteText = mergedText;
      }
      setStatus('live');
    } catch (e) {
      setStatus('error');
    }
    busy = false;
  }

  function schedulePush() {
    if (!enabled) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(cycle, 400);
  }

  /* ---------- status / room UI ---------- */

  function setStatus(s) {
    status = enabled ? s : 'off';
    const dot = document.getElementById('sync-dot');
    if (dot) {
      dot.className = 'sync-dot sync-' + status;
      dot.title = statusText();
    }
    const label = document.getElementById('sync-status');
    if (label) label.textContent = statusText();
  }

  function statusText() {
    if (!enabled) return 'sync off';
    if (status === 'live') return `live · room "${room}"`;
    if (status === 'error') return 'offline — will retry';
    return 'connecting…';
  }

  function setRoom(r) {
    const cleaned = String(r || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
    if (!cleaned) return;
    room = cleaned;
    localStorage.setItem('ba-room', room);
    version = 0;
    lastRemoteText = '';
    setStatus('connecting');
    cycle();
  }

  function setEnabled(on) {
    enabled = !!on;
    localStorage.setItem('ba-sync-enabled', enabled ? '1' : '0');
    setStatus(enabled ? 'connecting' : 'off');
    if (enabled) cycle();
  }

  /* ---------- lifecycle ---------- */

  setInterval(() => { if (!document.hidden) cycle(); }, 3000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) cycle(); });
  setTimeout(cycle, 100);

  return {
    schedulePush, setRoom, setEnabled, statusText,
    get room() { return room; },
    get enabled() { return enabled; },
  };
})();
