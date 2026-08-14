/* Bracket Attack — state & persistence */
'use strict';

const Store = (() => {
  const KEY = 'bracket-attack-v1';

  let state = load() || blank();

  function blank() {
    return { players: [], staticTeams: [], tournaments: [],
             settings: {}, signups: [],
             deleted: { players: {}, staticTeams: {}, tournaments: {} } };
  }

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && !s.deleted) s.deleted = { players: {}, staticTeams: {}, tournaments: {} };
      if (s && !s.settings) s.settings = {};
      if (s && !s.signups) s.signups = [];
      return s;
    }
    catch { return null; }
  }

  const now = () => new Date().toISOString();

  function save() {
    localStorage.setItem(KEY, JSON.stringify(state));
    if (typeof Sync !== 'undefined') Sync.schedulePush();
  }

  // adopt a merged state coming from sync (persist without re-pushing)
  function replace(newState) {
    state = newState;
    localStorage.setItem(KEY, JSON.stringify(state));
  }

  /* ---------- players ---------- */

  function addPlayers(names) {
    const existing = new Set(state.players.map(p => p.name.toLowerCase()));
    let added = 0;
    for (const raw of names) {
      const name = raw.trim();
      if (!name || existing.has(name.toLowerCase())) continue;
      state.players.push({ id: uid('p'), name, updatedAt: now() });
      existing.add(name.toLowerCase());
      added++;
    }
    save();
    return added;
  }

  function removePlayer(id) {
    const ts = now();
    state.deleted.players[id] = ts;
    state.players = state.players.filter(p => p.id !== id);
    state.staticTeams.forEach(t => {
      if (t.playerIds.includes(id)) {
        t.playerIds = t.playerIds.filter(pid => pid !== id);
        t.updatedAt = ts;
      }
    });
    state.staticTeams = state.staticTeams.filter(t => {
      if (t.playerIds.length > 0) return true;
      state.deleted.staticTeams[t.id] = ts;
      return false;
    });
    save();
  }

  function playerName(id) {
    const p = state.players.find(p => p.id === id);
    if (p) return p.name;
    // fall back to a name snapshotted on a tournament roster
    for (const t of state.tournaments) {
      for (const team of t.teams) {
        const hit = (team.roster || []).find(r => r.id === id);
        if (hit) return hit.name;
      }
    }
    return '(removed)';
  }

  /* ---------- static teams ---------- */

  function addStaticTeam(name, playerIds, opts = {}) {
    state.staticTeams.push({
      id: uid('st'), name, playerIds: [...playerIds],
      pending: !!opts.pending, createdBy: opts.createdBy || '',
      updatedAt: now(),
    });
    save();
  }

  function confirmStaticTeam(id) {
    const t = state.staticTeams.find(x => x.id === id);
    if (t) { t.pending = false; t.updatedAt = now(); save(); }
  }

  function removeStaticTeam(id) {
    state.deleted.staticTeams[id] = now();
    state.staticTeams = state.staticTeams.filter(t => t.id !== id);
    save();
  }

  /* ---------- tournaments ---------- */

  function tournament(id) {
    return state.tournaments.find(t => t.id === id);
  }

  function removeTournament(id) {
    state.deleted.tournaments[id] = now();
    state.tournaments = state.tournaments.filter(t => t.id !== id);
    save();
  }

  function teamOf(t, teamId) {
    return t.teams.find(x => x.id === teamId) || null;
  }

  function teamName(t, teamId) {
    const team = teamOf(t, teamId);
    return team ? team.name : 'TBD';
  }

  /* ---------- who is playing right now? ---------- */

  // Map of playerId -> { tournament, match } for every player in a live match.
  function busyPlayers() {
    const map = new Map();
    for (const t of state.tournaments) {
      if (t.status !== 'active') continue;
      for (const m of t.matches) {
        if (m.status !== 'live') continue;
        for (const side of ['teamA', 'teamB']) {
          const team = teamOf(t, m[side]);
          if (!team) continue;
          for (const pid of team.playerIds) map.set(pid, { tournament: t, match: m });
        }
      }
    }
    return map;
  }

  /* ---------- tournament-of-tournaments leaderboard ----------
     1st place team: 4 pts per player · 2nd: 3 · 3rd: 2 · everyone else: 1 */

  function leaderboard() {
    const rows = new Map();
    const row = (pid) => {
      if (!rows.has(pid)) {
        rows.set(pid, { id: pid, name: playerName(pid), points: 0, played: 0, wins: 0, podiums: 0 });
      }
      return rows.get(pid);
    };
    for (const t of state.tournaments) {
      if (t.status !== 'complete') continue;
      const podium = [t.placements.first, t.placements.second, t.placements.third];
      for (const team of t.teams) {
        const place = podium.indexOf(team.id);
        const pts = place === 0 ? 4 : place === 1 ? 3 : place === 2 ? 2 : 1;
        for (const pid of team.playerIds) {
          const r = row(pid);
          r.points += pts;
          r.played += 1;
          if (place === 0) r.wins += 1;
          if (place >= 0 && place <= 2) r.podiums += 1;
        }
      }
    }
    return [...rows.values()].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  }

  /* ---------- event signups (Chris's flow: players pick their games) ---------- */

  function playerByName(name) {
    const n = String(name || '').trim().toLowerCase();
    return state.players.find(p => p.name.toLowerCase() === n) || null;
  }

  // a logged-in guest IS a competitor — create their player record on demand
  function ensurePlayer(name) {
    let p = playerByName(name);
    if (!p && String(name || '').trim()) {
      addPlayers([name]);
      p = playerByName(name);
    }
    return p;
  }

  function signupOf(playerId) {
    return (state.signups || []).find(s => s.id === playerId) || null;
  }

  function gamesOf(playerId) {
    const s = signupOf(playerId);
    return s ? s.games : [];
  }

  function toggleSignup(playerId, game) {
    if (!state.signups) state.signups = [];
    let s = signupOf(playerId);
    if (!s) { s = { id: playerId, games: [], updatedAt: now() }; state.signups.push(s); }
    const i = s.games.indexOf(game);
    if (i >= 0) s.games.splice(i, 1); else s.games.push(game);
    s.updatedAt = now();
    save();
    return s.games.includes(game);
  }

  function signupsFor(game) {
    return (state.signups || [])
      .filter(s => s.games.includes(game))
      .map(s => s.id)
      .filter(id => state.players.some(p => p.id === id));
  }

  /* ---------- shared settings (synced last-write-wins) ---------- */

  function setting(key) {
    return (state.settings || {})[key];
  }

  function setSetting(key, value) {
    if (!state.settings) state.settings = {};
    state.settings[key] = value;
    state.settings.updatedAt = now();
    save();
  }

  /* ---------- import / export ---------- */

  function exportJSON() {
    return JSON.stringify(state, null, 2);
  }

  function importJSON(json) {
    const data = JSON.parse(json);
    if (!data || !Array.isArray(data.players) || !Array.isArray(data.tournaments)) {
      throw new Error('Not a Bracket Attack backup file.');
    }
    data.staticTeams = data.staticTeams || [];
    data.deleted = data.deleted || { players: {}, staticTeams: {}, tournaments: {} };
    state = data;
    save();
  }

  function resetAll() {
    const ts = now();
    const deleted = state.deleted || { players: {}, staticTeams: {}, tournaments: {} };
    state.players.forEach(p => deleted.players[p.id] = ts);
    state.staticTeams.forEach(t => deleted.staticTeams[t.id] = ts);
    state.tournaments.forEach(t => deleted.tournaments[t.id] = ts);
    state = { players: [], staticTeams: [], tournaments: [], deleted };
    save();
  }

  return {
    get state() { return state; },
    save, replace, addPlayers, removePlayer, playerName,
    addStaticTeam, removeStaticTeam, confirmStaticTeam,
    tournament, removeTournament, teamOf, teamName,
    busyPlayers, leaderboard, setting, setSetting,
    playerByName, ensurePlayer, gamesOf, toggleSignup, signupsFor,
    exportJSON, importJSON, resetAll,
  };
})();
