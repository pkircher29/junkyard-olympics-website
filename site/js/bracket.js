/* Bracket Attack — bracket engine: single or double elimination,
   random or seeded draw, 3rd-place match (single elim) and same-leg
   dynamic substitution. Matches carry `src` descriptors ([matchId, 'w'|'l']
   per side) so slot-filling, bye cascades and merge reconciliation are all
   one generic propagate() pass. */
'use strict';

const Bracket = (() => {

  const now = () => new Date().toISOString();

  function nextPow2(n) {
    let p = 1;
    while (p < n) p *= 2;
    return p;
  }

  // Bracket slot order by seed for P slots, so #1 and #2 meet in the final:
  // P=8 -> [1,8,4,5,2,7,3,6]. Seeds beyond the team count become byes,
  // which lands the byes on the top seeds.
  function seedPositions(P) {
    let arr = [1];
    while (arr.length < P) {
      const n = arr.length * 2;
      const next = [];
      for (const x of arr) next.push(x, n + 1 - x);
      arr = next;
    }
    return arr;
  }

  /* Create a tournament. `teams` = [{name, playerIds, kind: 'static'|'random'}] */
  function createTournament({ name, game, icon, rules, teamSize, teams, format, seeded }) {
    const t = {
      id: uid('t'),
      name, game, icon,
      rules: {
        target: Math.max(1, Number(rules.target) || 21),
        winBy: Math.max(0, Number(rules.winBy) || 0),
        notes: rules.notes || '',
      },
      teamSize,
      format: format === 'double' ? 'double' : 'single',
      seeded: !!seeded,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      teams: teams.map(team => ({
        id: uid('tm'),
        name: team.name,
        kind: team.kind,
        playerIds: [...team.playerIds],
        roster: team.playerIds.map(pid => ({ id: pid, name: Store.playerName(pid) })),
      })),
      matches: [],
      rounds: 0,
      placements: { first: null, second: null, third: null },
    };
    buildMatches(t);
    Store.state.tournaments.unshift(t);
    Store.save();
    return t;
  }

  function baseMatch(id, round, idx, extra = {}) {
    return {
      id, round, idx,
      teamA: null, teamB: null, scoreA: 0, scoreB: 0,
      status: 'pending',     // pending -> live -> done
      winner: null, bye: false,
      isFinal: false, isThird: false,
      updatedAt: now(),
      ...extra,
    };
  }

  function buildMatches(t) {
    const ordered = t.seeded ? t.teams.map(x => x.id) : shuffle(t.teams.map(x => x.id));
    const N = ordered.length;
    const P = Math.max(2, nextPow2(N));
    const R = Math.round(Math.log2(P));

    // Round 1 pairs by seed slot (random draw = shuffled "seeds").
    const slots = seedPositions(P).map(s => ordered[s - 1] || null);
    const pairs = [];
    for (let i = 0; i < P / 2; i++) {
      let a = slots[2 * i], b = slots[2 * i + 1];
      if (!a && b) { a = b; b = null; }
      pairs.push([a, b]);
    }

    const dbl = t.format === 'double' && N >= 3;
    const matches = [];

    // Winners (or only) bracket.
    for (let r = 1; r <= R; r++) {
      const count = P / Math.pow(2, r);
      for (let i = 0; i < count; i++) {
        matches.push(baseMatch(`r${r}m${i}`, r, i, {
          br: 'W',
          teamA: r === 1 ? pairs[i][0] : null,
          teamB: r === 1 ? pairs[i][1] : null,
          isFinal: !dbl && r === R && i === 0,
          src: r === 1 ? undefined : {
            a: [`r${r - 1}m${2 * i}`, 'w'],
            b: [`r${r - 1}m${2 * i + 1}`, 'w'],
          },
        }));
      }
    }

    if (dbl) {
      // Losers bracket: rounds 1..2R-2. Odd rounds pair losers-bracket
      // survivors; even rounds drop in the losers from winners round k+1.
      const L = 2 * R - 2;
      for (let l = 1; l <= L; l++) {
        const k = Math.ceil(l / 2);
        const count = P / Math.pow(2, k + 1);
        for (let i = 0; i < count; i++) {
          let src;
          if (l === 1) src = { a: [`r1m${2 * i}`, 'l'], b: [`r1m${2 * i + 1}`, 'l'] };
          else if (l % 2 === 0) src = { a: [`l${l - 1}m${i}`, 'w'], b: [`r${k + 1}m${i}`, 'l'] };
          else src = { a: [`l${l - 1}m${2 * i}`, 'w'], b: [`l${l - 1}m${2 * i + 1}`, 'w'] };
          matches.push(baseMatch(`l${l}m${i}`, l, i, { br: 'L', src }));
        }
      }
      matches.push(baseMatch('gf', R + 1, 0, {
        br: 'G', isFinal: true,
        src: { a: [`r${R}m0`, 'w'], b: [`l${L}m0`, 'w'] },
      }));
      t.lbRounds = L;
    } else {
      t.lbRounds = 0;
      if (R >= 2) {
        matches.push(baseMatch('third', R, 99, {
          isThird: true, skipped: false,
          src: { a: [`r${R - 1}m0`, 'l'], b: [`r${R - 1}m1`, 'l'] },
        }));
      }
    }

    t.matches = matches;
    t.rounds = R;

    // Auto-advance byes in round 1, then cascade.
    for (const m of matches.filter(m => m.br !== 'L' && m.round === 1 && !m.isThird)) {
      if (m.teamA && !m.teamB) {
        m.winner = m.teamA; m.status = 'done'; m.bye = true;
      }
    }
    propagate(t);
  }

  function loserOf(m) {
    if (!m.winner) return null;
    const other = m.winner === m.teamA ? m.teamB : m.teamA;
    return other || null;
  }

  /* ---------- generic slot propagation ----------
     Fills empty slots from each match's `src` results, auto-advances byes
     (a side whose source finished with no team to send), and marks matches
     with two dead sides as skipped. Only fills empty slots on pending
     matches, so admin swaps survive. Idempotent — also used after merges. */

  function srcResult(t, ref) {
    const sm = t.matches.find(x => x.id === ref[0]);
    if (!sm || sm.status !== 'done') return { ready: !sm, team: null };
    return { ready: true, team: ref[1] === 'w' ? sm.winner : loserOf(sm) };
  }

  function propagate(t) {
    if (!t.matches.some(m => m.src)) { legacyReconcile(t); return; }
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 50) {
      changed = false;
      for (const m of t.matches) {
        if (m.status !== 'pending' || !m.src) continue;
        for (const side of ['a', 'b']) {
          const key = side === 'a' ? 'teamA' : 'teamB';
          if (m[key] || !m.src[side]) continue;
          const r = srcResult(t, m.src[side]);
          if (r.ready && r.team) { m[key] = r.team; m.updatedAt = now(); changed = true; }
        }
        const dead = s => m.src[s] ? (srcResult(t, m.src[s]).ready && !srcResult(t, m.src[s]).team) : false;
        if (m.teamA && !m.teamB && dead('b')) {
          m.winner = m.teamA; m.status = 'done'; m.bye = true; m.updatedAt = now(); changed = true;
        } else if (m.teamB && !m.teamA && dead('a')) {
          m.winner = m.teamB; m.status = 'done'; m.bye = true; m.updatedAt = now(); changed = true;
        } else if (!m.teamA && !m.teamB && dead('a') && dead('b')) {
          m.status = 'done'; m.skipped = true; m.winner = null; m.updatedAt = now(); changed = true;
        }
      }
    }
  }

  // Matches fed (directly or transitively) from m via the src graph.
  function descendants(t, m) {
    const out = [];
    const seen = new Set([m.id]);
    const queue = [m.id];
    while (queue.length) {
      const id = queue.shift();
      for (const x of t.matches) {
        if (seen.has(x.id) || !x.src) continue;
        if ((x.src.a && x.src.a[0] === id) || (x.src.b && x.src.b[0] === id)) {
          seen.add(x.id); out.push(x); queue.push(x.id);
        }
      }
    }
    return out;
  }

  // Once both semifinals finish, populate (or short-circuit) the 3rd-place match.
  function maybeSetupThird(t) {
    const semis = t.matches.filter(x => !x.isThird && x.round === t.rounds - 1);
    if (!semis.every(s => s.status === 'done')) return;
    const third = t.matches.find(x => x.isThird);
    if (!third || third.status === 'done') return;
    const losers = semis.map(loserOf).filter(Boolean);
    if (losers.length === 2) {
      third.teamA = losers[0];
      third.teamB = losers[1];
    } else {
      // 0 or 1 real losers (bye semifinal) — nothing to play for.
      third.winner = losers[0] || null;
      third.status = 'done';
      third.skipped = true;
    }
    third.updatedAt = now();
  }

  function isReady(m) {
    return m.status === 'pending' && m.teamA && m.teamB;
  }

  /* ---------- dynamic same-leg substitution ----------
     If a team about to start has players who are mid-match in ANY tournament,
     swap that team with a fully-free team from another not-yet-started match
     on the same round ("equal leg") of this bracket. */

  function planStart(t, m) {
    const busy = Store.busyPlayers();
    const swaps = [];
    const stuck = [];
    const claimed = new Set([m.teamA, m.teamB]);

    for (const side of ['teamA', 'teamB']) {
      const team = Store.teamOf(t, m[side]);
      if (!team) continue;
      const busyMembers = team.playerIds.filter(pid => busy.has(pid));
      if (!busyMembers.length) continue;

      const cand = findSwap(t, m, busy, claimed);
      const where = busy.get(busyMembers[0]).tournament.name;
      if (cand) {
        claimed.add(cand.teamId);
        swaps.push({
          mSide: side,
          matchId: cand.matchId,
          side: cand.side,
          inId: cand.teamId,
          outId: m[side],
          note: `⚡ <b>${esc(team.name)}</b> is mid-game in <b>${esc(where)}</b> — ` +
                `<b>${esc(Store.teamName(t, cand.teamId))}</b> subbed onto this leg.`,
        });
      } else {
        stuck.push({
          team,
          names: busyMembers.map(Store.playerName).join(', '),
          where,
        });
      }
    }
    return { swaps, stuck };
  }

  function findSwap(t, m, busy, claimed) {
    for (const mm of t.matches) {
      if (mm.id === m.id || mm.status !== 'pending') continue;
      if (mm.round !== m.round || mm.isThird !== m.isThird || (mm.br || '') !== (m.br || '')) continue;
      for (const side of ['teamA', 'teamB']) {
        const id = mm[side];
        if (!id || claimed.has(id)) continue;
        const team = Store.teamOf(t, id);
        if (team && team.playerIds.every(pid => !busy.has(pid))) {
          return { matchId: mm.id, side, teamId: id };
        }
      }
    }
    return null;
  }

  function applyStart(t, m, plan) {
    for (const s of plan.swaps) {
      const mm = t.matches.find(x => x.id === s.matchId);
      mm[s.side] = s.outId;
      m[s.mSide] = s.inId;
      mm.updatedAt = now();
    }
    m.status = 'live';
    m.startedAt = new Date().toISOString();
    m.updatedAt = now();
    t.updatedAt = now();
    Store.save();
  }

  /* ---------- finishing ---------- */

  function finishMatch(t, m, winnerId) {
    m.status = 'done';
    m.winner = winnerId;
    m.endedAt = new Date().toISOString();
    m.updatedAt = now();
    propagate(t);
    checkComplete(t);
    t.updatedAt = now();
    Store.save();
  }

  // Record score taps with a timestamp so per-match merge works.
  function touchMatch(t, m) {
    m.updatedAt = now();
    t.updatedAt = now();
  }

  /* ---------- host/admin operations ----------
     Each returns null on success or an error string. */

  // Reopen a finished match to fix a score. Blocked if the teams involved
  // already played later matches (reopen those first, newest to oldest).
  function reopenMatch(t, m) {
    if (m.bye || m.status !== 'done') return 'Only finished matches can be reopened.';
    const w = m.winner, l = loserOf(m);

    if (t.matches.some(x => x.src)) {
      // src-graph path (all new tournaments, both formats)
      const down = descendants(t, m)
        .filter(x => (w && (x.teamA === w || x.teamB === w)) || (l && (x.teamA === l || x.teamB === l)) || x.bye || x.skipped);
      if (down.some(x => x.status === 'done' && !x.bye && !x.skipped) || down.some(x => x.status === 'live')) {
        return 'Later matches involving these teams were already played — reopen those first.';
      }
      for (const x of down) {
        if (x.bye || x.skipped) {
          Object.assign(x, { status: 'pending', winner: null, bye: false, skipped: false, scoreA: 0, scoreB: 0 });
        }
        if (x.teamA === w || x.teamA === l) x.teamA = null;
        if (x.teamB === w || x.teamB === l) x.teamB = null;
        x.updatedAt = now();
      }
      m.status = 'live'; m.winner = null; m.endedAt = null; m.updatedAt = now();
      propagate(t);
      if (t.status === 'complete') { t.status = 'active'; t.placements = { first: null, second: null, third: null }; }
      t.updatedAt = now();
      Store.save();
      return null;
    }

    // legacy single-elim data without src descriptors
    const downstream = t.matches.filter(x => x.id !== m.id && (x.isThird || x.round > m.round) &&
      ((w && (x.teamA === w || x.teamB === w)) || (l && (x.teamA === l || x.teamB === l))));
    if (downstream.some(x => x.status !== 'pending')) {
      return 'Later matches involving these teams were already played — reopen those first.';
    }
    for (const x of downstream) {
      if (x.teamA === w || x.teamA === l) x.teamA = null;
      if (x.teamB === w || x.teamB === l) x.teamB = null;
      x.updatedAt = now();
    }
    const third = t.matches.find(x => x.isThird);
    if (third && third.skipped && m.round === t.rounds - 1) {
      Object.assign(third, { teamA: null, teamB: null, scoreA: 0, scoreB: 0,
        status: 'pending', winner: null, skipped: false, updatedAt: now() });
    }
    m.status = 'live'; m.winner = null; m.endedAt = null; m.updatedAt = now();
    if (t.status === 'complete') { t.status = 'active'; t.placements = { first: null, second: null, third: null }; }
    t.updatedAt = now();
    Store.save();
    return null;
  }

  // Fresh bracket, same teams, reshuffled draw.
  function restart(t) {
    buildMatches(t);
    t.status = 'active';
    t.placements = { first: null, second: null, third: null };
    t.updatedAt = now();
    Store.save();
  }

  // Swap two teams between their current (not-yet-started) bracket slots.
  function swapSlots(t, idA, idB) {
    if (!idA || !idB || idA === idB) return 'Pick two different teams.';
    const map = new Map();
    for (const m of t.matches) {
      if (m.status !== 'pending') continue;
      if (m.teamA) map.set(m.teamA, { m, side: 'teamA' });
      if (m.teamB) map.set(m.teamB, { m, side: 'teamB' });
    }
    const a = map.get(idA), b = map.get(idB);
    if (!a || !b) return 'Both teams must be waiting in matches that have not started.';
    a.m[a.side] = idB;
    b.m[b.side] = idA;
    a.m.updatedAt = now(); b.m.updatedAt = now(); t.updatedAt = now();
    Store.save();
    return null;
  }

  // Swap two players between teams, or sub in a pool player for a rostered one.
  function movePlayer(t, pidA, pidB) {
    if (!pidA || !pidB || pidA === pidB) return 'Pick two different players.';
    const teamOfP = (pid) => t.teams.find(tm => tm.playerIds.includes(pid));
    const ta = teamOfP(pidA);
    if (!ta) return 'The first pick must be a player currently on a team.';
    const tb = teamOfP(pidB);
    const ia = ta.playerIds.indexOf(pidA);
    if (tb) {
      const ib = tb.playerIds.indexOf(pidB);
      ta.playerIds[ia] = pidB;
      tb.playerIds[ib] = pidA;
      tb.roster = tb.playerIds.map(pid => ({ id: pid, name: Store.playerName(pid) }));
    } else {
      ta.playerIds[ia] = pidB;
    }
    ta.roster = ta.playerIds.map(pid => ({ id: pid, name: Store.playerName(pid) }));
    t.updatedAt = now();
    Store.save();
    return null;
  }

  function checkComplete(t) {
    if (t.format === 'double' && t.matches.some(x => x.br === 'G')) {
      const gf = t.matches.find(x => x.br === 'G');
      if (gf.status !== 'done') return;
      const lbFinal = t.matches.find(x => x.br === 'L' && x.round === t.lbRounds && x.idx === 0);
      t.status = 'complete';
      t.completedAt = new Date().toISOString();
      t.placements = {
        first: gf.winner,
        second: loserOf(gf),
        third: lbFinal ? loserOf(lbFinal) : null,
      };
      return;
    }
    const final = t.matches.find(x => x.isFinal);
    const third = t.matches.find(x => x.isThird);
    if (!final || final.status !== 'done') return;
    if (third && third.status !== 'done') return;
    t.status = 'complete';
    t.completedAt = new Date().toISOString();
    t.placements = {
      first: final.winner,
      second: loserOf(final),
      third: third ? third.winner : null,
    };
  }

  /* ---------- sync support ----------
     Merge two replicas of the same tournament: newest metadata wins,
     matches merge individually by updatedAt, then the bracket is
     reconciled so winners from one device feed matches on another. */

  function mergeTournaments(local, remote) {
    const base = ((remote.updatedAt || '') > (local.updatedAt || '')) ? remote : local;
    const other = base === local ? remote : local;
    const t = JSON.parse(JSON.stringify(base));
    const otherById = new Map((other.matches || []).map(m => [m.id, m]));
    t.matches = t.matches.map(m => {
      const o = otherById.get(m.id);
      return (o && (o.updatedAt || '') > (m.updatedAt || ''))
        ? JSON.parse(JSON.stringify(o)) : m;
    });
    reconcile(t);
    return t;
  }

  /* Re-derive cross-match state after a merge. Only fills empty slots —
     never overwrites — so substitution swaps survive. */
  function reconcile(t) {
    propagate(t);
    if (t.status !== 'complete') checkComplete(t);
  }

  // pre-src single-elim replicas: derive feeds the old way
  function legacyReconcile(t) {
    for (const m of t.matches) {
      if (m.isThird || m.isFinal || m.status !== 'done' || !m.winner) continue;
      const next = t.matches.find(x =>
        !x.isThird && x.round === m.round + 1 && x.idx === (m.idx >> 1));
      if (next && next.status === 'pending') {
        const side = m.idx % 2 === 0 ? 'teamA' : 'teamB';
        if (!next[side]) next[side] = m.winner;
      }
    }
    if (t.rounds >= 2) {
      const third = t.matches.find(x => x.isThird);
      if (third && third.status === 'pending' && !third.teamA && !third.teamB) {
        maybeSetupThird(t);
      }
    }
  }

  function progress(t) {
    const real = t.matches.filter(m => !m.bye && !m.skipped);
    const done = real.filter(m => m.status === 'done').length;
    return { done, total: real.length };
  }

  function roundName(t, r) {
    if (r === t.rounds) return 'Final';
    if (r === t.rounds - 1) return 'Semifinals';
    if (r === t.rounds - 2) return 'Quarterfinals';
    return `Round ${r}`;
  }

  // Human label for any match in either format.
  function matchLabel(t, m) {
    if (m.isThird) return '3rd place';
    if (m.br === 'G') return 'Grand Final';
    if (m.br === 'L') return m.round === t.lbRounds ? 'Losers Final' : `Losers Rd ${m.round}`;
    if (m.br === 'W' && t.format === 'double') {
      if (m.round === t.rounds) return 'Winners Final';
      if (m.round === t.rounds - 1) return 'Winners Semis';
      return `Round ${m.round}`;
    }
    return roundName(t, m.round);
  }

  return { createTournament, isReady, planStart, applyStart, finishMatch, touchMatch,
           reopenMatch, restart, swapSlots, movePlayer,
           mergeTournaments, reconcile, progress, roundName, matchLabel, loserOf };
})();
