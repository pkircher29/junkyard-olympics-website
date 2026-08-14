/* Bracket Attack — view rendering */
'use strict';

const Views = (() => {

  /* =============== login gate =============== */

  function loginGate() {
    return `
    <section class="hero" style="max-width:440px;margin:4vh auto 0">
      <img class="heroart" src="assets/junkyard-hero.jpg" alt="Junkyard Olympics">
      <div class="hero-stripe"></div>
      <h1>Junkyard <em>Olympics</em></h1>
      <p class="muted">One login for the scoreboard and the jukebox.</p>
      <div class="card form" style="margin-top:18px;text-align:left">
        <label class="f">Your name<input id="a-name" maxlength="24" autocomplete="off"></label>
        <label class="f">Party password<input id="a-pass" type="password"></label>
        <button class="btn btn-accent btn-lg" data-action="auth-login">🏆 Let me in</button>
      </div>
    </section>`;
  }

  // QR-link landing: the password is baked into the link, so a guest only
  // types their name. Same-device identity persists in localStorage.
  function joinGate(code) {
    return `
    <section class="hero" style="max-width:440px;margin:4vh auto 0">
      <img class="heroart" src="assets/junkyard-hero.jpg" alt="Junkyard Olympics">
      <div class="hero-stripe"></div>
      <h1>Junkyard <em>Olympics</em></h1>
      <p class="muted">You scanned the poster — one step left. What do we call you?</p>
      <div class="card form" style="margin-top:18px;text-align:left">
        <label class="f">Your name<input id="j-name" maxlength="24" autocomplete="off" placeholder="e.g. Big Wrench Wanda"></label>
        <button class="btn btn-accent btn-lg" data-action="join-go" data-code="${esc(code)}">🔥 I'm in</button>
        <p class="muted small" style="margin-top:8px">No password, no account — your phone remembers you all day.</p>
      </div>
    </section>`;
  }

  // Host tool: bake the party password into a QR poster for the gate/TV.
  function qrPage() {
    if (!Auth.isHost) return `<section><div class="empty">🎛 Hosts only.</div></section>`;
    return `
    <section>
      <a class="backlink" href="#/">← Overview</a>
      <h2>📱 Party signup QR</h2>
      <div class="card form">
        <p class="muted small">Enter the party password — it gets baked into the link so guests
          scan, type their name, and they're in. One scan signs them into the scoreboard <b>and</b> the jukebox.
          Print it and tape it to the cooler.</p>
        <div class="addrow">
          <input id="qr-pass" type="text" placeholder="party password" autocomplete="off">
          <button class="btn btn-accent" data-action="qr-make">⚙ Generate poster</button>
        </div>
        <div id="qr-out"></div>
      </div>
    </section>`;
  }

  /* =============== shared bits =============== */

  function statusChip(t) {
    if (t.status === 'complete') return `<span class="chip chip-done">🏁 Complete</span>`;
    const live = t.matches.some(m => m.status === 'live');
    return live
      ? `<span class="chip chip-live"><span class="pulse"></span>LIVE</span>`
      : `<span class="chip chip-active">Active</span>`;
  }

  function rosterNames(team) {
    return team.playerIds.map(Store.playerName).join(' · ');
  }

  function rulesChips(t) {
    const r = t.rules;
    return `
      <span class="chip chip-rule">🎯 First to ${r.target}</span>
      ${r.winBy ? `<span class="chip chip-rule">win by ${r.winBy}</span>` : ''}
      <span class="chip chip-rule">${t.teamSize} player${t.teamSize > 1 ? 's' : ''}/team</span>
      <span class="chip chip-rule">${t.format === 'double' ? '⚔ Double elim' : '🗡 Single elim'}</span>
      ${t.seeded ? '<span class="chip chip-rule">📋 Seeded</span>' : ''}`;
  }

  /* =============== overview =============== */

  function overview() {
    const s = Store.state;
    const liveMatches = s.tournaments.flatMap(t => t.matches.filter(m => m.status === 'live'));
    const active = s.tournaments.filter(t => t.status === 'active');
    const complete = s.tournaments.filter(t => t.status === 'complete');
    const busy = Store.busyPlayers();

    const cards = s.tournaments.map(t => {
      const p = Bracket.progress(t);
      const pct = p.total ? Math.round(p.done / p.total * 100) : 0;
      const champ = t.status === 'complete'
        ? `<div class="card-champ">🥇 ${esc(Store.teamName(t, t.placements.first))}</div>` : '';
      return `
      <a class="tcard" href="#/t/${t.id}">
        <div class="tcard-top">
          <span class="tcard-icon">${t.icon}</span>
          ${statusChip(t)}
        </div>
        <h3>${esc(t.name)}</h3>
        <div class="muted">${esc(t.game)} · ${t.teams.length} teams</div>
        ${champ}
        <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
        <div class="muted small">${p.done}/${p.total} matches played</div>
      </a>`;
    }).join('');

    const lb = Store.leaderboard();
    const medals = ['🥇', '🥈', '🥉'];
    const lbRows = lb.map((r, i) => `
      <tr class="${i < 3 ? 'podium-' + (i + 1) : ''}">
        <td class="rank">${i < 3 ? medals[i] : i + 1}</td>
        <td>${esc(r.name)} ${busy.has(r.id) ? '<span class="badge-live" title="currently playing">🎮</span>' : ''}</td>
        <td class="pts">${r.points}</td>
        <td>${r.played}</td>
        <td>${r.wins}</td>
        <td>${r.podiums}</td>
      </tr>`).join('');

    return `
    <section class="hero hero-banner">
      <img class="heroart" src="assets/junkyard-hero.jpg" alt="">
      <div class="hero-stripe"></div>
      <h1>Junkyard <em>Olympics</em></h1>
      <p class="muted">The tournament of tournaments. Scrap for glory. 🔧</p>
      ${Auth.isHost ? '<p style="margin-top:8px"><a class="btn btn-ghost btn-sm" href="#/qr">📱 Party signup QR</a></p>' : ''}
      <div class="stats">
        <div class="stat"><b>${liveMatches.length}</b><span>live matches</span></div>
        <div class="stat"><b>${active.length}</b><span>active tournaments</span></div>
        <div class="stat"><b>${s.players.length}</b><span>players</span></div>
        <div class="stat"><b>${complete.length}</b><span>completed</span></div>
      </div>
    </section>

    <section>
      <div class="sec-head">
        <h2>Tournaments</h2>
        <a class="btn btn-accent" href="#/new">+ New Tournament</a>
      </div>
      ${s.tournaments.length
        ? `<div class="tgrid">${cards}</div>`
        : `<div class="empty">No events yet. Add some <a href="#/players">athletes</a>, then fire up your first bracket. 🌽🐴🔩</div>`}
    </section>

    <section>
      <div class="sec-head"><h2>Medal Table</h2>
        <span class="muted small">1st = 4 pts · 2nd = 3 · 3rd = 2 · played = 1</span></div>
      ${lb.length ? `
      <div class="tablewrap"><table class="lb">
        <thead><tr><th></th><th>Player</th><th>Points</th><th>Played</th><th>Titles</th><th>Podiums</th></tr></thead>
        <tbody>${lbRows}</tbody>
      </table></div>`
      : `<div class="empty">Standings appear once a tournament finishes.</div>`}
    </section>

    <section>
      <div class="sec-head"><h2>Live Sync</h2>
        <span id="sync-status" class="muted small">${typeof Sync !== 'undefined' ? Sync.statusText() : ''}</span></div>
      <div class="card">
        <div class="addrow">
          <input id="sync-room" value="${typeof Sync !== 'undefined' ? esc(Sync.room) : ''}"
                 placeholder="room code" maxlength="40">
          <button class="btn btn-accent" data-action="sync-join">Join room</button>
          <button class="btn btn-ghost" data-action="sync-toggle">${typeof Sync !== 'undefined' && Sync.enabled ? 'Turn sync off' : 'Turn sync on'}</button>
        </div>
        <p class="muted small">Every phone or tablet that opens this site and joins the same room shares one
          live scoreboard — scores, brackets and standings update everywhere within a few seconds.
          Keep one scorekeeper per match; everything else merges automatically.</p>
      </div>
    </section>

    <section class="datatools">
      <button class="btn btn-ghost btn-sm" data-action="export-data">⬇ Export backup</button>
      ${Auth.isHost ? `
      <label class="btn btn-ghost btn-sm">⬆ Import backup<input type="file" id="import-file" accept=".json" hidden></label>
      <button class="btn btn-danger btn-sm" data-action="reset-all">Reset everything</button>` : ''}
    </section>`;
  }

  /* =============== players & teams =============== */

  function players() {
    const s = Store.state;
    const busy = Store.busyPlayers();

    const chips = s.players.map(p => `
      <span class="pchip">
        ${esc(p.name)}
        ${busy.has(p.id) ? `<span class="badge-live" title="playing in ${esc(busy.get(p.id).tournament.name)}">🎮</span>` : ''}
        <button class="x" data-action="remove-player" data-id="${p.id}" title="remove">×</button>
      </span>`).join('');

    const teamCards = s.staticTeams.map(t => `
      <div class="card teamcard">
        <div class="sec-head"><h3>${esc(t.name)}</h3>
          <button class="btn btn-ghost btn-sm" data-action="remove-team" data-id="${t.id}">Delete</button></div>
        <div class="muted">${t.playerIds.map(Store.playerName).map(esc).join(' · ')}</div>
      </div>`).join('');

    const boxes = s.players.map(p => `
      <label class="check"><input type="checkbox" class="team-pick" value="${p.id}"> ${esc(p.name)}</label>`).join('');

    return `
    <section>
      <div class="sec-head"><h2>Player Pool</h2><span class="muted small">${s.players.length} players</span></div>
      <div class="card">
        <div class="addrow">
          <input id="new-players" placeholder="Add names — comma or newline separated (e.g. Pat, Sam, Alex)">
          <button class="btn btn-accent" data-action="add-players">Add</button>
        </div>
        <div class="chips">${chips || '<span class="muted">No players yet — add the whole crew above.</span>'}</div>
        <p class="muted small">🎮 = currently in a live match somewhere.</p>
      </div>
    </section>

    <section>
      <div class="sec-head"><h2>Static Teams</h2>
        <span class="muted small">Fixed rosters available in every tournament</span></div>
      <div class="card">
        <div class="addrow">
          <input id="team-name" placeholder="Team name (e.g. The Ringers)">
          <button class="btn btn-accent" data-action="create-team">Create team</button>
        </div>
        <div class="checkgrid">${boxes || '<span class="muted">Add players first.</span>'}</div>
      </div>
      <div class="teamgrid">${teamCards}</div>
    </section>`;
  }

  /* =============== new tournament =============== */

  let draft = null;

  function newDraft() {
    const g = GAME_PRESETS[0];
    return {
      name: '', gameIdx: 0, customGame: '',
      target: g.target, winBy: g.winBy, notes: g.notes,
      teamSize: 2, staticIds: new Set(), randomTeams: [], bench: [],
      format: 'single', seeded: '',
    };
  }

  function resetDraft() { draft = newDraft(); }
  function getDraft() { if (!draft) draft = newDraft(); return draft; }

  function shuffleDraftTeams() {
    const d = getDraft();
    const taken = new Set();
    for (const id of d.staticIds) {
      const st = Store.state.staticTeams.find(t => t.id === id);
      if (st) st.playerIds.forEach(p => taken.add(p));
    }
    const free = shuffle(Store.state.players.filter(p => !taken.has(p.id)).map(p => p.id));
    const groups = chunk(free, d.teamSize);
    const full = groups.filter(g => g.length === d.teamSize);
    const leftover = groups.filter(g => g.length < d.teamSize).flat();
    const used = new Set();
    d.randomTeams = full.map(g => ({ name: randomTeamName(used), playerIds: g, kind: 'random' }));
    d.bench = leftover;
  }

  function draftTeamCount() {
    return getDraft().staticIds.size + getDraft().randomTeams.length;
  }

  function newTournament() {
    const d = getDraft();
    const s = Store.state;

    const gameBtns = GAME_PRESETS.map((g, i) => `
      <button class="gbtn ${i === d.gameIdx ? 'on' : ''}" data-action="draft-game" data-i="${i}">
        <span>${g.icon}</span>${g.name}</button>`).join('');

    const staticBoxes = s.staticTeams.map(t => `
      <label class="check">
        <input type="checkbox" data-action="draft-static" data-id="${t.id}" ${d.staticIds.has(t.id) ? 'checked' : ''}>
        <b>${esc(t.name)}</b> <span class="muted small">(${t.playerIds.map(Store.playerName).map(esc).join(', ')})</span>
      </label>`).join('');

    const preview = d.randomTeams.map((t, i) => `
      <div class="rteam"><b>${d.seeded ? `#${d.staticIds.size + i + 1} ` : ''}${esc(t.name)}</b><span class="muted small">${t.playerIds.map(Store.playerName).map(esc).join(' · ')}</span></div>`).join('');

    return `
    <section>
      <h2>New Tournament</h2>
      <div class="card form">

        <label class="f">Tournament name
          <input id="d-name" data-field="name" value="${esc(d.name)}" placeholder="Friday Night Cornhole"></label>

        <label class="f">Game</label>
        <div class="gamerow">${gameBtns}</div>
        ${d.gameIdx === GAME_PRESETS.length - 1
          ? `<label class="f">Custom game name
              <input data-field="customGame" value="${esc(d.customGame)}" placeholder="Bocce, KanJam, ..."></label>` : ''}

        <fieldset class="f-rules">
          <legend>Scoring rules <span class="muted small">(locked in when the tournament begins)</span></legend>
          <div class="rulesrow">
            <label class="f">Play to <input type="number" min="1" data-field="target" value="${d.target}"></label>
            <label class="f">Win by <input type="number" min="0" max="5" data-field="winBy" value="${d.winBy}"></label>
            <label class="f">Team size
              <select data-field="teamSize">
                ${[1, 2, 3, 4].map(n => `<option value="${n}" ${d.teamSize === n ? 'selected' : ''}>${n}v${n}</option>`).join('')}
              </select></label>
          </div>
          <label class="f">House rules / notes
            <textarea data-field="notes" rows="2" placeholder="Bust back to 15, cancellation scoring...">${esc(d.notes)}</textarea></label>
        </fieldset>

        <fieldset class="f-rules">
          <legend>Bracket format</legend>
          <div class="rulesrow">
            <label class="f">Elimination
              <select data-field="format">
                <option value="single" ${d.format !== 'double' ? 'selected' : ''}>Single elimination</option>
                <option value="double" ${d.format === 'double' ? 'selected' : ''}>Double elimination</option>
              </select></label>
            <label class="f">Draw
              <select data-field="seeded">
                <option value="" ${!d.seeded ? 'selected' : ''}>🎲 Random draw</option>
                <option value="1" ${d.seeded ? 'selected' : ''}>📋 Seeded</option>
              </select></label>
          </div>
          <p class="muted small">${d.format === 'double'
            ? 'Double elim: lose once and you drop to the losers bracket — lose twice and you\'re out. Losers-bracket champ meets the winners-bracket champ in the Grand Final (needs 3+ teams).'
            : 'Single elim: lose and you\'re out. Semifinal losers play a 3rd-place match.'}
          ${d.seeded ? ' Seeding follows the order below — static teams first (in checked order), then random teams. #1 meets #2 in the final; byes go to top seeds.' : ''}</p>
        </fieldset>

        <fieldset class="f-rules">
          <legend>Teams</legend>
          ${s.staticTeams.length ? `<p class="muted small">Include static teams:</p><div class="checkgrid">${staticBoxes}</div>` : ''}
          <div class="sec-head" style="margin-top:12px">
            <p class="muted small">Random teams drawn from the remaining player pool:</p>
            <button class="btn btn-ghost btn-sm" data-action="draft-shuffle">🎲 ${d.randomTeams.length ? 'Reshuffle' : 'Draw teams'}</button>
          </div>
          <div class="rteams">${preview || '<span class="muted small">No random teams drawn yet.</span>'}</div>
          ${d.bench.length ? `<p class="muted small">On the bench (not enough for a full team): ${d.bench.map(Store.playerName).map(esc).join(', ')}</p>` : ''}
          <p class="draftcount ${draftTeamCount() >= 2 ? 'ok' : ''}">${draftTeamCount()} team${draftTeamCount() === 1 ? '' : 's'} entered</p>
        </fieldset>

        <button class="btn btn-accent btn-lg" data-action="draft-create">🚀 Start Tournament</button>
      </div>
    </section>`;
  }

  /* =============== tournament page =============== */

  function matchCard(t, m) {
    const row = (teamId, score, isWinner) => {
      const team = Store.teamOf(t, teamId);
      const label = team ? esc(team.name)
        : (m.bye ? '<span class="muted">BYE</span>' : '<span class="muted">TBD</span>');
      return `<div class="mrow ${isWinner ? 'won' : (m.status === 'done' && team ? 'lost' : '')}">
        <span class="mname" ${team ? `title="${esc(rosterNames(team))}"` : ''}>${label}</span>
        <span class="mscore">${m.status !== 'pending' && team ? score : ''}</span>
      </div>`;
    };
    let action = '';
    if (m.status === 'live') {
      action = `<a class="btn btn-live btn-sm" href="#/m/${t.id}/${m.id}"><span class="pulse"></span>Score it</a>`;
    } else if (Bracket.isReady(m) && t.status === 'active') {
      action = `<button class="btn btn-accent btn-sm" data-action="start-match" data-mid="${m.id}">▶ Start</button>`;
    } else if (m.status === 'done' && !m.bye && !m.skipped && Auth.isHost) {
      action = `<button class="btn btn-ghost btn-sm" title="reopen to fix the score" data-action="reopen-match" data-mid="${m.id}">🎛 ↺ Fix</button>`;
    }
    return `
    <div class="match ${m.status}" id="match-${m.id}">
      ${row(m.teamA, m.scoreA, m.status === 'done' && m.winner === m.teamA)}
      ${row(m.teamB, m.scoreB, m.status === 'done' && m.winner === m.teamB)}
      ${action ? `<div class="mact">${action}</div>` : ''}
    </div>`;
  }

  function tournamentPage(t) {
    if (!t) return `<section><div class="empty">Tournament not found. <a href="#/">Back to overview</a>.</div></section>`;

    const podium = t.status === 'complete' ? `
      <div class="podium card">
        <div class="pod pod-1">🥇<b>${esc(Store.teamName(t, t.placements.first))}</b><span>4 pts each</span></div>
        ${t.placements.second ? `<div class="pod pod-2">🥈<b>${esc(Store.teamName(t, t.placements.second))}</b><span>3 pts each</span></div>` : ''}
        ${t.placements.third ? `<div class="pod pod-3">🥉<b>${esc(Store.teamName(t, t.placements.third))}</b><span>2 pts each</span></div>` : ''}
        <div class="pod pod-rest">🔩<b>Everyone else</b><span>1 pt each</span></div>
      </div>` : '';

    const live = t.matches.filter(m => m.status === 'live');
    const ready = t.matches.filter(m => Bracket.isReady(m));
    const queue = (t.status === 'active' && (live.length || ready.length)) ? `
      <div class="queue">
        ${live.map(m => `<div class="qitem qlive">
            <span class="chip chip-live"><span class="pulse"></span>LIVE</span>
            <b>${esc(Store.teamName(t, m.teamA))}</b> vs <b>${esc(Store.teamName(t, m.teamB))}</b>
            <span class="muted small">${Bracket.matchLabel(t, m)}</span>
            <a class="btn btn-live btn-sm" href="#/m/${t.id}/${m.id}">Score it</a>
          </div>`).join('')}
        ${ready.map(m => `<div class="qitem">
            <span class="chip chip-active">UP NEXT</span>
            <b>${esc(Store.teamName(t, m.teamA))}</b> vs <b>${esc(Store.teamName(t, m.teamB))}</b>
            <span class="muted small">${Bracket.matchLabel(t, m)}</span>
            <button class="btn btn-accent btn-sm" data-action="start-match" data-mid="${m.id}">▶ Start</button>
          </div>`).join('')}
      </div>` : '';

    const col = (title, ms) => `<div class="round"><h4>${title}</h4>
      <div class="roundcol">${ms.map(m => matchCard(t, m)).join('')}</div></div>`;

    let bracketHtml;
    if (t.format === 'double' && t.matches.some(m => m.br === 'G')) {
      const wCols = [];
      for (let r = 1; r <= t.rounds; r++) {
        const ms = t.matches.filter(m => m.br === 'W' && m.round === r && !m.skipped);
        if (ms.length) wCols.push(col(Bracket.matchLabel(t, ms[0]), ms));
      }
      const gf = t.matches.find(m => m.br === 'G');
      wCols.push(col('🏆 Grand Final', [gf]));
      const lCols = [];
      for (let l = 1; l <= (t.lbRounds || 0); l++) {
        const ms = t.matches.filter(m => m.br === 'L' && m.round === l && !m.skipped);
        if (ms.length) lCols.push(col(Bracket.matchLabel(t, ms[0]), ms));
      }
      bracketHtml = `
        <h3 class="brh">Winners Bracket</h3>
        <div class="bracket">${wCols.join('')}</div>
        <h3 class="brh">💀 Losers Bracket <span class="muted small">— lose here and you're out; survive and crash the Grand Final</span></h3>
        ${lCols.length ? `<div class="bracket">${lCols.join('')}</div>` : '<div class="empty">Losers bracket fills in as winners-bracket matches finish.</div>'}`;
    } else {
      const cols = [];
      for (let r = 1; r <= t.rounds; r++) {
        const ms = t.matches.filter(m => m.round === r && !m.isThird && (m.br || 'W') === 'W');
        cols.push(col(Bracket.roundName(t, r), ms));
      }
      const third = t.matches.find(m => m.isThird);
      if (third && !third.skipped) {
        cols.push(col('3rd Place', [third]));
      }
      bracketHtml = `<div class="bracket">${cols.join('')}</div>`;
    }

    const teams = t.teams.map(team => `
      <div class="card teamcard">
        <div class="sec-head"><h3>${esc(team.name)}</h3>
          <span class="chip ${team.kind === 'static' ? 'chip-static' : 'chip-random'}">${team.kind === 'static' ? '📌 static' : '🎲 random'}</span></div>
        <div class="muted">${esc(rosterNames(team))}</div>
      </div>`).join('');

    return `
    <section>
      <a class="backlink" href="#/">← All tournaments</a>
      <div class="thead">
        <span class="thead-icon">${t.icon}</span>
        <div>
          <h1>${esc(t.name)}</h1>
          <div class="chiprow">${statusChip(t)} <span class="chip chip-rule">${esc(t.game)}</span> ${rulesChips(t)}</div>
          ${t.rules.notes ? `<p class="muted small">📋 ${esc(t.rules.notes).replace(/\n/g, '<br>')}</p>` : ''}
        </div>
      </div>
      ${podium}
      ${queue}
      <h2>Bracket</h2>
      ${bracketHtml}
      <h2>Teams</h2>
      <div class="teamgrid">${teams}</div>
      ${Auth.isHost ? adminTools(t) : ''}
    </section>`;
  }

  /* Host-only tools: fix brackets, rosters, and mistakes. */
  function adminTools(t) {
    const slotTeams = [];
    for (const m of t.matches) {
      if (m.status !== 'pending') continue;
      for (const side of ['teamA', 'teamB']) {
        if (m[side]) slotTeams.push({ id: m[side], label: `${Store.teamName(t, m[side])} — ${Bracket.matchLabel(t, m)}` });
      }
    }
    const slotOpts = slotTeams.map(s => `<option value="${s.id}">${esc(s.label)}</option>`).join('');

    const rostered = [];
    for (const team of t.teams) for (const pid of team.playerIds) {
      rostered.push({ id: pid, label: `${Store.playerName(pid)} (${team.name})` });
    }
    const inT = new Set(rostered.map(r => r.id));
    const pool = Store.state.players.filter(p => !inT.has(p.id))
      .map(p => ({ id: p.id, label: `${p.name} (not in this tournament)` }));
    const pOptsA = rostered.map(r => `<option value="${r.id}">${esc(r.label)}</option>`).join('');
    const pOptsB = rostered.concat(pool).map(r => `<option value="${r.id}">${esc(r.label)}</option>`).join('');

    return `
      <h2>🎛 Admin tools</h2>
      <div class="card form">
        <p class="muted small">Move a team to a different leg of the bracket (both must be in matches that haven't started):</p>
        <div class="rulesrow">
          <label class="f">Team<select id="adm-slot-a">${slotOpts || '<option value="">—</option>'}</select></label>
          <label class="f">swaps with<select id="adm-slot-b">${slotOpts || '<option value="">—</option>'}</select></label>
        </div>
        <button class="btn btn-ghost" data-action="adm-swap-slots">↔ Swap bracket slots</button>

        <p class="muted small" style="margin-top:10px">Reassign players — swap two players between teams, or sub in someone from the pool:</p>
        <div class="rulesrow">
          <label class="f">Player<select id="adm-p-a">${pOptsA || '<option value="">—</option>'}</select></label>
          <label class="f">swaps with / is replaced by<select id="adm-p-b">${pOptsB || '<option value="">—</option>'}</select></label>
        </div>
        <button class="btn btn-ghost" data-action="adm-swap-players">🔁 Reassign players</button>

        <div class="rulesrow" style="margin-top:10px">
          <button class="btn btn-ghost" data-action="adm-restart">♻ Restart bracket <span class="muted small">(same teams, new draw)</span></button>
          <button class="btn btn-danger" data-action="del-tournament" data-id="${t.id}">Delete tournament</button>
        </div>
      </div>`;
  }

  /* =============== scorekeeping page =============== */

  function scorePage(t, m) {
    if (!t || !m) return `<section><div class="empty">Match not found. <a href="#/">Back</a>.</div></section>`;
    const r = t.rules;
    const teamA = Store.teamOf(t, m.teamA);
    const teamB = Store.teamOf(t, m.teamB);

    const panel = (team, side, score) => {
      const atTarget = score >= r.target && (r.winBy === 0 || score - (side === 'A' ? m.scoreB : m.scoreA) >= r.winBy);
      const isWinner = m.status === 'done' && m.winner === (side === 'A' ? m.teamA : m.teamB);
      return `
      <div class="spanel ${atTarget && m.status === 'live' ? 'at-target' : ''} ${isWinner ? 'winner' : ''}">
        <h3>${esc(team ? team.name : 'TBD')}</h3>
        <div class="sroster muted small">${team ? esc(rosterNames(team)) : ''}</div>
        <div class="sscore">${score}</div>
        ${m.status === 'live' ? `
        <div class="sbtns">
          <button class="btn btn-score" data-action="score-add" data-side="${side}" data-n="1">+1</button>
          <button class="btn btn-score" data-action="score-add" data-side="${side}" data-n="2">+2</button>
          <button class="btn btn-score" data-action="score-add" data-side="${side}" data-n="3">+3</button>
          <button class="btn btn-ghost" data-action="score-add" data-side="${side}" data-n="-1">−1</button>
        </div>` : ''}
        ${isWinner ? '<div class="wintag">🏆 WINNER</div>' : ''}
      </div>`;
    };

    return `
    <section class="scorepage">
      <a class="backlink" href="#/t/${t.id}">← ${esc(t.name)}</a>
      <div class="scorehead">
        <h2>${t.icon} ${m.isThird ? '3rd Place Match' : Bracket.matchLabel(t, m)}</h2>
        <div class="chiprow">
          <span class="chip chip-rule">🎯 First to ${r.target}${r.winBy ? `, win by ${r.winBy}` : ''}</span>
          ${m.status === 'live' ? '<span class="chip chip-live"><span class="pulse"></span>LIVE</span>' : ''}
          ${m.status === 'done' ? '<span class="chip chip-done">Final</span>' : ''}
        </div>
        ${r.notes ? `<p class="muted small">📋 ${esc(r.notes).replace(/\n/g, '<br>')}</p>` : ''}
      </div>
      <div class="scoreboard">
        ${panel(teamA, 'A', m.scoreA)}
        <div class="vs">VS</div>
        ${panel(teamB, 'B', m.scoreB)}
      </div>
      <div class="scoreactions">
        ${m.status === 'pending' && Bracket.isReady(m)
          ? `<button class="btn btn-accent btn-lg" data-action="start-match" data-mid="${m.id}">▶ Start match</button>` : ''}
        ${m.status === 'live'
          ? `<button class="btn btn-accent btn-lg" data-action="finish-match">🏁 Finish — declare winner</button>` : ''}
        ${m.status === 'done'
          ? `<a class="btn btn-ghost" href="#/t/${t.id}">Back to bracket</a>` : ''}
      </div>
    </section>`;
  }

  return { overview, players, newTournament, tournamentPage, scorePage, loginGate,
           joinGate, qrPage,
           getDraft, resetDraft, shuffleDraftTeams, draftTeamCount };
})();
