/* Bracket Attack — view rendering */
'use strict';

const Views = (() => {

  /* =============== login gate =============== */

  function loginGate() {
    return `
    <section class="signup">
      <div class="herowrap">
        <img class="heroart" src="assets/junkyard-hero.jpg" alt="Junkyard Olympics">
        <span class="hero-plate"><small>SATURDAY</small>2 PM</span>
        <span class="hero-sticker">ADULTS ONLY</span>
      </div>
      <div class="steprow"><span>STEP 1 OF 2</span><span>NO EMAIL. NO ACCOUNT.</span></div>
      <h1 class="bigask">What should<br>we call you?</h1>
      <input id="a-name" maxlength="24" autocomplete="off" placeholder="e.g. Rivet Rosie">
      <p class="asknote">This public name appears on the scoreboard.</p>
      <input id="a-pass" type="password" autocomplete="off" placeholder="Party password (it's on the poster)">
      <button class="cta" data-action="auth-login"><span>Pick my events</span><span>→</span></button>
      <div class="sitefoot">One login · scoreboard + jukebox · synced live · no telemetry</div>
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

  // Host tool: QR poster that simply opens the site — guests log in with
  // their name + the guest password (posted at the party).
  function qrPage() {
    if (!Auth.isHost) return `<section><div class="empty">🎛 Hosts only.</div></section>`;
    return `
    <section>
      <a class="backlink" href="#/">← Overview</a>
      <h2>📱 Party signup QR</h2>
      <div class="card form">
        <p class="muted small">The QR just opens the website — guests type their name and the
          guest password (write it on the poster or the cooler). One login covers the scoreboard
          <b>and</b> the jukebox.</p>
        <button class="btn btn-accent" data-action="qr-make">⚙ Generate poster</button>
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
        ${Auth.isHost ? '<a class="btn btn-accent" href="#/new">+ New Tournament</a>'
          : '<span><a class="btn btn-accent btn-sm" href="#/games">🎟 Pick your events</a> <a class="btn btn-ghost btn-sm" href="#/players">🤝 Form your team</a></span>'}
      </div>
      ${s.tournaments.length
        ? `<div class="tgrid">${cards}</div>`
        : `<div class="empty">No events yet. Add some <a href="#/players">athletes</a>${Auth.isHost ? ', then fire up your first bracket. 🌽🐴🔩' : ' and form your team — the hosts start the brackets. 🌽🐴🔩'}</div>`}
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

    ${hqCard()}

    <section class="datatools">
      <button class="btn btn-ghost btn-sm" data-action="export-data">⬇ Export backup</button>
      ${Auth.isHost ? `
      <label class="btn btn-ghost btn-sm">⬆ Import backup<input type="file" id="import-file" accept=".json" hidden></label>
      <button class="btn btn-danger btn-sm" data-action="reset-all">Reset everything</button>` : ''}
    </section>`;
  }

  /* =============== Event HQ bridge (Chris's LAN control tower) =============== */

  function hqUrl() { return (Store.setting('hqUrl') || '').replace(/\/+$/, ''); }

  function hqCard() {
    const hq = hqUrl();
    if (!hq) {
      return Auth.isHost ? `
      <section>
        <div class="sec-head"><h2>🎪 Event HQ</h2></div>
        <div class="card"><p class="muted small">Chris's control tower (TV broadcast · cannon scoring · Flair) isn't
          linked yet. <a href="#/hq" style="color:var(--accent)">Connect it →</a></p></div>
      </section>` : '';
    }
    return `
    <section>
      <div class="sec-head"><h2>🎪 Event HQ <span class="muted small">— Chris's control tower</span></h2>
        ${Auth.isHost ? '<a class="btn btn-ghost btn-sm" href="#/hq">⚙ Configure</a>' : ''}</div>
      <div class="card">
        <div class="chiprow" style="gap:10px;flex-wrap:wrap">
          <a class="btn btn-accent" href="${esc(hq)}/tv.html" target="_blank" rel="noopener">📺 TV Broadcast</a>
          <a class="btn btn-ghost" href="${esc(hq)}/participant.html" target="_blank" rel="noopener">🧑‍🔧 My Yard</a>
          <a class="btn btn-ghost" href="${esc(hq)}/index.html" target="_blank" rel="noopener">📝 HQ Signup</a>
        </div>
        <div id="hq-standings" style="margin-top:10px"><p class="muted small">Reaching HQ…</p></div>
        <p class="muted small">Works when this device can reach the control tower — party Wi-Fi, Tailscale, or a Tailscale Funnel URL.</p>
      </div>
    </section>`;
  }

  async function loadHqStandings() {
    const box = $('#hq-standings');
    const hq = hqUrl();
    if (!box || !hq) return;
    try {
      const ctl = new AbortController();
      setTimeout(() => ctl.abort(), 5000);
      const [champ, flair] = await Promise.all([
        fetch(hq + '/api/standings/championship', { signal: ctl.signal }).then(r => r.json()),
        fetch(hq + '/api/standings/flair', { signal: ctl.signal }).then(r => r.json()),
      ]);
      const rows = (champ.standings || []).slice(0, 8).map((r, i) => `
        <tr><td class="rank">${i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}</td>
        <td>${esc(r.displayName)}</td><td class="pts">${r.total}</td><td>${r.eligible ? '✅' : '—'}</td></tr>`).join('');
      const fl = (flair.standings || []).slice(0, 6).map(r =>
        `<span class="pchip">${esc(r.displayName)} <b>${r.total}</b></span>`).join('');
      box.innerHTML = `
        ${rows ? `<h3 class="brh">🏆 HQ Championship <span class="muted small">(Cannon + best 3 field events)</span></h3>
          <div class="tablewrap"><table class="lb">
            <thead><tr><th></th><th>Player</th><th>Points</th><th>Podium-eligible</th></tr></thead>
            <tbody>${rows}</tbody></table></div>` : ''}
        ${fl ? `<h3 class="brh">🎭 Flair standings</h3><div class="statchips">${fl}</div>` : ''}
        ${!rows && !fl ? '<p class="muted small">HQ is reachable — no standings on the board yet.</p>' : ''}`;
    } catch {
      box.innerHTML = '<p class="muted small">📡 HQ not reachable from this device right now — links above still work on the party network.</p>';
    }
  }

  function hqPage() {
    if (!Auth.isHost) return `<section><div class="empty">🎛 Hosts only.</div></section>`;
    return `
    <section>
      <a class="backlink" href="#/">← Overview</a>
      <div class="sec-head">
        <div><span class="eyebrow">verified host controls</span><h2>🎪 Event HQ</h2></div>
        <span id="hq-connection" class="chip chip-rule">CONNECTING</span>
      </div>
      <div class="card">
        <p class="muted small">The website uses its fixed secure Event HQ route. There is no paste-a-server-URL box and no browser-stored organizer secret.</p>
      </div>
    </section>

    <section id="cannon-admin" data-cannon-state="loading" aria-labelledby="cannon-admin-title">
      <div class="sec-head">
        <h2 id="cannon-admin-title">💥 Junkyard Cannon</h2>
        <span class="chip chip-active">HOSTS ONLY</span>
      </div>
      <div id="cannon-status" class="warning" role="status"><b>CHECKING EVENT HQ…</b></div>
      <div id="cannon-admin-content" class="card form cannon-admin-shell">
        <div id="cannon-target-editor" class="cannon-admin-targets"><p class="muted small">Loading authoritative teams, targets, and run state…</p></div>
        <div class="cannon-admin-disabled-grid">
          <button class="btn btn-accent" data-action="cannon-setup-save" disabled>Confirm approved setup</button>
          <button class="btn btn-danger" data-action="cannon-safety-stop" disabled>🛑 Safety Stop</button>
        </div>
      </div>
    </section>`;
  }

  /* =============== competitor pass (Chris's guest home screen) =============== */

  function myTeamIds(t, pid) {
    return new Set(t.teams.filter(tm => tm.playerIds.includes(pid)).map(tm => tm.id));
  }

  function competitorPass() {
    const s = Store.state;
    const me = Store.playerByName(Auth.name);
    const myGames = me ? Store.gamesOf(me.id) : [];

    // sweep every tournament for my matches: the call card, results, counts
    let call = null, played = 0;
    const results = [];
    if (me) for (const t of s.tournaments) {
      const teams = myTeamIds(t, me.id);
      if (!teams.size) continue;
      for (const m of t.matches) {
        const mineA = teams.has(m.teamA), mineB = teams.has(m.teamB);
        if (!mineA && !mineB) continue;
        if (m.status === 'done' && !m.bye && !m.skipped) {
          played++;
          results.push({ t, m, won: teams.has(m.winner), myScore: mineA ? m.scoreA : m.scoreB,
                         oppScore: mineA ? m.scoreB : m.scoreA, opp: mineA ? m.teamB : m.teamA,
                         myTeam: mineA ? m.teamA : m.teamB });
        }
        if (m.status === 'live') call = { t, m, live: true };
        else if (!call && Bracket.isReady(m) && t.status === 'active') call = { t, m, live: false };
      }
    }
    results.sort((a, b) => (b.m.endedAt || '') < (a.m.endedAt || '') ? -1 : 1);

    // 01 UP NEXT — one row per event I entered
    const upNext = myGames.map(g => {
      const preset = GAME_PRESETS.find(x => x.name === g) || { icon: '🏅' };
      const t = s.tournaments.find(x => x.game === g && x.status === 'active') ||
                s.tournaments.find(x => x.game === g);
      let status = 'Entered · wait for your call', chip = 'READY', chipCls = 'chip-active', href = '#/games';
      if (t) {
        href = `#/t/${t.id}`;
        const teams = me ? myTeamIds(t, me.id) : new Set();
        if (t.status === 'complete') {
          const podium = [t.placements.first, t.placements.second, t.placements.third];
          const place = [...teams].map(id => podium.indexOf(id)).filter(i => i >= 0)[0];
          status = place != null ? `Finished ${['🥇 1st', '🥈 2nd', '🥉 3rd'][place]}` : 'Event wrapped';
          chip = 'DONE'; chipCls = 'chip-done';
        } else if (teams.size) {
          const next = t.matches.find(m => (teams.has(m.teamA) || teams.has(m.teamB)) &&
            (m.status === 'live' || m.status === 'pending'));
          if (next && next.status === 'live') { status = `LIVE — ${Bracket.matchLabel(t, next)}`; chip = 'LIVE'; chipCls = 'chip-live'; href = `#/m/${t.id}/${next.id}`; }
          else if (next && Bracket.isReady(next)) { status = `You're up — ${Bracket.matchLabel(t, next)}`; chip = 'GO'; chipCls = 'chip-live'; }
          else if (next) { status = 'In the bracket — waiting on earlier matches'; chip = 'SOON'; chipCls = 'chip-active'; }
          else { status = 'Your run is over for this one'; chip = 'DONE'; chipCls = 'chip-done'; }
        } else {
          status = 'Bracket drawn — on the bench (subs happen!)'; chip = 'BENCH'; chipCls = 'chip-rule';
        }
      }
      return `
      <a class="passrow" href="${href}">
        <span class="passicon">${preset.icon}</span>
        <span class="passinfo"><b>${esc(g).toUpperCase()}</b><small>${status}</small></span>
        <span class="chip ${chipCls}">${chip}</span>
      </a>`;
    }).join('');

    const lb = Store.leaderboard();
    const lbRows = lb.slice(0, 8).map((r, i) => `
      <tr class="${me && r.id === me.id ? 'podium-1' : ''}">
        <td class="rank">${i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}</td>
        <td>${esc(r.name)}${me && r.id === me.id ? ' ← you' : ''}</td>
        <td class="pts">${r.points}</td><td>${r.played}</td>
      </tr>`).join('');

    // "X of Y results complete" — per entered event, complete = my run there is over
    const totalEvents = myGames.length;
    const doneEvents = myGames.filter(g => {
      const t = s.tournaments.find(x => x.game === g);
      if (!t) return false;
      if (t.status === 'complete') return true;
      const teams = me ? myTeamIds(t, me.id) : new Set();
      if (!teams.size) return false;
      return !t.matches.some(mm => (teams.has(mm.teamA) || teams.has(mm.teamB)) && mm.status !== 'done');
    }).length;

    return `
    <section class="pass">
      <div class="card passhead">
        <p class="eyebrow">your day in the yard</p>
        <div class="sec-head" style="margin:0">
          <h1>Hey, ${esc(Auth.name)}.</h1>
          <div class="passcount"><b>${doneEvents} of ${totalEvents}</b><small>results complete</small></div>
        </div>
        <div class="passprog"><i style="width:${totalEvents ? Math.round(doneEvents / totalEvents * 100) : 0}%"></i></div>
      </div>

      ${call ? `
      <a class="callcard ${call.live ? 'live' : ''}" href="#/m/${call.t.id}/${call.m.id}">
        <p class="eyebrow">${call.live ? '● match in progress' : 'report to your station'}</p>
        <h2>${esc(call.t.name).toUpperCase()}</h2>
        <p class="callvs"><b>${esc(Store.teamName(call.t, call.m.teamA))}</b> <span>VS</span> <b>${esc(Store.teamName(call.t, call.m.teamB))}</b></p>
        <span class="btn ${call.live ? 'btn-live' : 'btn-accent'}">${call.live ? 'OPEN LIVE MATCH →' : 'GO TO MATCH →'}</span>
      </a>` : `
      <div class="card quietcard">No match is calling you right now. Stay nearby — this card lights up when it's time to play.</div>`}

      <h2 class="plate"><span class="pnum p-yellow">01</span><span class="ptitle"><small>stay loose</small><span class="ptext">Up Next</span></span></h2>
      ${myGames.length ? `<div class="passrows">${upNext}</div>`
        : `<div class="empty">You haven't entered any events yet — <a href="#/games">pick your events</a> to get on the boards. 🎟</div>`}

      <h2 class="plate"><span class="pnum p-rust">02</span><span class="ptitle"><small>in the books</small><span class="ptext">Your Results</span></span></h2>
      ${results.length ? `<div class="passrows">${results.map(r => `
        <a class="passrow" href="#/m/${r.t.id}/${r.m.id}">
          <span class="passicon">${r.t.icon}</span>
          <span class="passinfo"><b>${r.won ? 'W' : 'L'} · ${esc(Store.teamName(r.t, r.myTeam))} ${r.myScore}–${r.oppScore}</b>
            <small>vs ${esc(Store.teamName(r.t, r.opp))} · ${esc(r.t.name)}</small></span>
          <span class="chip ${r.won ? 'chip-done' : 'chip-rule'}">${r.won ? 'WON' : 'LOST'}</span>
        </a>`).join('')}</div>`
        : `<div class="card quietcard">No completed results yet. Finished matches will stack up here.</div>`}

      <h2 class="plate"><span class="pnum p-steel">03</span><span class="ptitle"><small>tournament of tournaments</small><span class="ptext">Championship Standings</span></span></h2>
      ${lb.length ? `<div class="tablewrap"><table class="lb">
          <thead><tr><th></th><th>Player</th><th>Points</th><th>Played</th></tr></thead>
          <tbody>${lbRows}</tbody></table></div>`
        : `<div class="card quietcard">Standings appear once the first tournament finishes.</div>`}

      <h2 class="plate"><span class="pnum p-soot">04</span><span class="ptitle"><small>on the board</small><span class="ptext">All Tournaments</span></span></h2>
      ${s.tournaments.length ? `<div class="passrows">${s.tournaments.map(t => `
        <a class="passrow" href="#/t/${t.id}">
          <span class="passicon">${t.icon}</span>
          <span class="passinfo"><b>${esc(t.name).toUpperCase()}</b><small>${esc(t.game)} · ${t.teams.length} teams</small></span>
          ${statusChip(t)}
        </a>`).join('')}</div>`
        : `<div class="card quietcard">No brackets on the board yet — the hosts fire them up as the day rolls.</div>`}

      <p class="muted small" style="margin-top:18px;text-align:center">
        <a href="#/games" style="color:var(--accent)">🎟 change my events</a> ·
        <a href="#/players" style="color:var(--accent)">🤝 form a team</a> ·
        <a href="https://music.junkyardolympics.com" style="color:var(--accent)">🎶 jukebox</a></p>

      <div class="leaving">
        <h3>Leaving this phone?</h3>
        <p>Sign out only if the next person shouldn't open your competitor pass.</p>
        <a href="#" data-action="auth-logout">Sign out of this device</a>
      </div>
      <div class="sitefoot">Your pass stays on this device · one login for scoreboard + jukebox</div>
    </section>`;
  }

  /* =============== event signup (Chris's "pick my events" flow) =============== */

  function gamesSignup() {
    const me = Store.playerByName(Auth.name);
    const myGames = me ? Store.gamesOf(me.id) : [];
    const presets = GAME_PRESETS.filter(g => g.name !== 'Custom');
    const cannon = presets.find(g => g.name === 'Junkyard Cannon');
    const competitiveNames = new Set(['Cornhole', 'Ladder Golf', 'Lawn Darts', 'Washers', 'Field Pong', 'Bocce Ball', 'Volley Strike', 'Can Jam']);
    const competitive = presets.filter(g => competitiveNames.has(g.name));
    const casual = presets.filter(g => g !== cannon && !competitiveNames.has(g.name));

    const card = (g, kind, featured = false) => {
      const entered = Store.signupsFor(g.name);
      const iAmIn = myGames.includes(g.name);
      return `
      <article class="card event-signup-card ${featured ? 'cannon-signup-card' : ''} ${kind === 'casual' ? 'casual-signup-card' : 'competition-signup-card'}">
        <div class="event-card-main">
          <div class="event-card-icon" aria-hidden="true">${g.icon}</div>
          <div class="event-card-copy">
            <div class="event-type-row">
              <span class="event-type ${kind}">${featured ? 'Required championship event' : kind === 'competitive' ? 'Championship competition' : 'Signup · just for fun'}</span>
              ${featured ? '<span class="event-required">MUST COMPLETE</span>' : ''}
            </div>
            <h3>${esc(g.name)}</h3>
            ${featured ? '<p class="cannon-rule"><b>Want to compete for Junkyard Champion?</b> You must complete the Junkyard Cannon. Your championship total uses the Cannon plus your best three competitive-event scores.</p>' : kind === 'casual' ? '<p class="event-explainer">Come play, hang out, and get your name on the signup list. This event does not count toward Junkyard Champion.</p>' : '<p class="event-explainer">This event can count as one of your three best competitive-event scores.</p>'}
          </div>
          <button class="btn ${iAmIn ? 'btn-ghost' : 'btn-accent'} event-entry-button" data-action="toggle-game" data-game="${esc(g.name)}">
            ${iAmIn ? '✓ Entered — tap to leave' : "I'M IN →"}</button>
        </div>
        <p class="event-entry-list muted small">${entered.length
          ? `${entered.length} entered: ` + entered.map(Store.playerName).map(esc).join(' · ')
          : 'No entries yet — be the first.'}</p>
      </article>`;
    };

    return `
    <section class="event-signup-page">
      <p class="eyebrow">your day in the yard</p>
      <h2>Pick your events</h2>
      <p class="event-signup-intro">Hey, <b>${esc(Auth.name)}</b> — enter everything you want to play. The hosts draw each bracket from these entry lists. Change your mind any time before a bracket starts.</p>

      <div class="championship-rule-banner">
        <span class="championship-rule-number">CANNON + 3</span>
        <div><b>How Junkyard Champion works</b><span>Complete the Junkyard Cannon, then your best three scores from the competitive events below build your championship total.</span></div>
      </div>

      ${cannon ? card(cannon, 'competitive', true) : ''}

      <div class="event-section-heading"><div><span class="event-heading-kicker">Scores count</span><h3>Championship competition</h3></div><span class="event-section-mark competition">COMPETE</span></div>
      <div class="event-signup-grid">${competitive.map(g => card(g, 'competitive')).join('')}</div>

      <div class="event-section-heading casual-heading"><div><span class="event-heading-kicker">No championship pressure</span><h3>Signup and play for fun</h3></div><span class="event-section-mark casual">JUST PLAY</span></div>
      <p class="casual-section-copy">These still use signup lists so everyone knows who wants to play, but their results do not count toward Junkyard Champion.</p>
      <div class="event-signup-grid casual-grid">${casual.map(g => card(g, 'casual')).join('')}</div>

      <p class="muted small event-team-note">Want a set partner? <a href="#/players" style="color:var(--accent)">Form a team</a> after you've entered.</p>
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

    const me = (Auth.name || '').toLowerCase();
    const teamCards = s.staticTeams.map(t => {
      const isPartner = t.playerIds.some(pid => Store.playerName(pid).toLowerCase() === me) &&
                        me !== (t.createdBy || '').toLowerCase();
      const canConfirm = t.pending && (Auth.isHost || isPartner);
      return `
      <div class="card teamcard">
        <div class="sec-head"><h3>${esc(t.name)}</h3>
          <span>
            ${t.pending ? '<span class="chip chip-active">⏳ pending</span>' : ''}
            ${canConfirm ? `<button class="btn btn-accent btn-sm" data-action="confirm-team" data-id="${t.id}">✔ Confirm</button>` : ''}
            <button class="btn btn-ghost btn-sm" data-action="remove-team" data-id="${t.id}">${t.pending ? 'Decline' : 'Delete'}</button>
          </span></div>
        <div class="muted">${t.playerIds.map(Store.playerName).map(esc).join(' · ')}</div>
        ${t.pending ? `<p class="muted small">proposed by ${esc(t.createdBy || '?')} — the other teammate (or a host) confirms before it enters tournaments</p>` : ''}
      </div>`;
    }).join('');

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
      <div class="sec-head"><h2>${Auth.isHost ? 'Static Teams' : 'Form Your Team'}</h2>
        <span class="muted small">${Auth.isHost
          ? 'Fixed rosters available in every tournament'
          : 'Pick yourself + a partner (exactly 2) — your team rides into every tournament'}</span></div>
      <div class="card">
        <div class="addrow">
          <input id="team-name" placeholder="Team name (e.g. The Ringers)" maxlength="30">
          <button class="btn btn-accent" data-action="create-team">Create team</button>
        </div>
        <div class="checkgrid">${boxes || '<span class="muted">Add players first.</span>'}</div>
        <p class="muted small">Keep the name family-viewable — the censor bleeps anything spicy. 🧼</p>
      </div>
      <div class="teamgrid">${teamCards}</div>
    </section>`;
  }

  /* =============== Junkyard Constellation (Paul rules stay untouched) =============== */

  function photoVault() {
    return `
    <section class="photo-vault-page">
      <a class="backlink" href="#/">← Overview</a>
      <div class="photo-vault-hero">
        <div><span class="eyebrow">Party memories</span><h2>📸 Junkyard Constellation</h2><p class="muted small">The party’s private-to-approved memory wall.</p></div>
        <span class="chip chip-live">PRIVATE UNTIL APPROVED</span>
      </div>
      <div class="photo-vault-grid">
        <div class="card photo-vault-card">
          <h3>Add your party photo</h3>
          <p class="muted small">Choose a camera photo or something from your gallery. It goes privately to the organizers first. Tournament scoring and music never wait on photo processing.</p>
          <label class="photo-pick" for="vault-photo">📷 Choose camera or gallery</label>
          <input id="vault-photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" hidden>
          <img id="vault-preview" class="vault-preview" alt="Selected photo preview" hidden>
          <label class="f">Names to show <span class="muted small">(optional)</span>
            <input id="vault-names" maxlength="120" autocomplete="off" placeholder="Only include people who said yes"></label>
          <label class="vault-consent"><input id="vault-consent" type="checkbox"> <span>Everyone identifiable agreed this photo may appear on the Junkyard Olympics screen and may be archived in Constellation. I can request removal.</span></label>
          <button class="btn btn-accent btn-lg" data-action="photo-submit" id="vault-submit" disabled>Send privately for review</button>
          <div id="vault-status" class="photo-vault-status muted small" role="status">Choose a photo to begin.</div>
        </div>
        <div class="card">
          <div class="sec-head"><h3>Your submissions</h3><button class="btn btn-ghost btn-sm" data-action="photo-refresh">Refresh</button></div>
          <div id="vault-list"><p class="muted small">Loading your private submission history…</p></div>
        </div>
      </div>
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

  function draftGameName() {
    const d = getDraft();
    const preset = GAME_PRESETS[d.gameIdx];
    return preset.name === 'Custom' ? (d.customGame.trim() || 'Custom Game') : preset.name;
  }

  function shuffleDraftTeams() {
    const d = getDraft();
    const taken = new Set();
    for (const id of d.staticIds) {
      const st = Store.state.staticTeams.find(t => t.id === id);
      if (st) st.playerIds.forEach(p => taken.add(p));
    }
    // draw from the players who signed up for THIS game; whole pool if nobody has
    const enrolled = new Set(Store.signupsFor(draftGameName()));
    let candidates = Store.state.players.filter(p => !taken.has(p.id));
    if (enrolled.size) candidates = candidates.filter(p => enrolled.has(p.id));
    const free = shuffle(candidates.map(p => p.id));
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

    const staticBoxes = s.staticTeams.filter(t => !t.pending).map(t => `
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
            <p class="muted small">${(() => {
              const n = Store.signupsFor(draftGameName()).length;
              return n
                ? `🎟 <b>${n}</b> player${n === 1 ? '' : 's'} signed up for ${esc(draftGameName())} — random teams draw from them:`
                : `No event signups for ${esc(draftGameName())} yet — random teams draw from the whole pool:`;
            })()}</p>
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
           joinGate, qrPage, hqPage, loadHqStandings, gamesSignup, competitorPass, photoVault,
           getDraft, resetDraft, shuffleDraftTeams, draftTeamCount };
})();
