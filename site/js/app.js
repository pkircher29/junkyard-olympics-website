/* Bracket Attack — router & actions */
'use strict';

(() => {
  let route = { name: 'home' };

  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '');
    const parts = h.split('/').filter(Boolean);
    if (!parts.length) return { name: 'home' };
    if (parts[0] === 'players') return { name: 'players' };
    if (parts[0] === 'new') return { name: 'new' };
    if (parts[0] === 'join') return { name: 'join', code: parts[1] || '' };
    if (parts[0] === 'games') return { name: 'games' };
    if (parts[0] === 'photos') return { name: 'photos' };
    if (parts[0] === 'qr') return { name: 'qr' };
    if (parts[0] === 'hq') return { name: 'hq' };
    if (parts[0] === 't' && parts[1]) return { name: 'tournament', tid: parts[1] };
    if (parts[0] === 'm' && parts[1] && parts[2]) return { name: 'match', tid: parts[1], mid: parts[2] };
    return { name: 'home' };
  }

  function currentTournament() { return Store.tournament(route.tid); }
  function currentMatch() {
    const t = currentTournament();
    return t ? t.matches.find(m => m.id === route.mid) : null;
  }

  let lastViewKey = '';

  function render() {
    route = parseHash();
    // re-rendering the SAME view (e.g. toggling an event) keeps your scroll
    // position; only an actual page change jumps to the top
    const viewKey = [route.name, route.tid || '', route.mid || '', Auth.ok ? 1 : 0].join(':');
    const sameView = viewKey === lastViewKey;
    lastViewKey = viewKey;
    const keepY = window.scrollY;
    const settle = () => {
      window.scrollTo({ top: sameView ? keepY : 0, behavior: 'instant' });
    };
    const app = $('#app');
    const who = $('#who');
    if (who) who.textContent = Auth.ok ? `👤 ${Auth.name}${Auth.isHost ? ' 🎛' : ''} ↩` : '';
    // QR signup lands here — name-only join, no password typing (thanks Chris)
    if (route.name === 'join') {
      if (Auth.ok) { location.hash = '#/'; return; }
      app.innerHTML = Views.joinGate(route.code);
      const n = $('#j-name'); if (n) n.focus();
      settle();
      return;
    }
    if (!Auth.ok) { app.innerHTML = Views.loginGate(); settle(); return; }
    const newBtn = document.querySelector('.topnav [data-nav="new"]');
    if (newBtn) newBtn.style.display = Auth.isHost ? '' : 'none';
    if (route.name === 'qr') {
      app.innerHTML = Views.qrPage();
      settle();
      return;
    }
    if (route.name === 'hq') {
      app.innerHTML = Views.hqPage();
      if (Auth.isHost) void loadCannonAdmin();
      settle();
      return;
    }
    // TV nav link lights up once the LAN control tower is connected
    const tvLink = document.getElementById('nav-tv');
    const hqUrl = (Store.setting('hqUrl') || '').replace(/\/+$/, '');
    if (tvLink) {
      tvLink.style.display = hqUrl ? '' : 'none';
      if (hqUrl) tvLink.href = hqUrl + '/tv.html';
    }
    switch (route.name) {
      case 'games':      app.innerHTML = Views.gamesSignup(); break;
      case 'players':    app.innerHTML = Views.players(); break;
      case 'photos':
        app.innerHTML = Views.photoVault();
        loadPhotoVault();
        break;
      case 'new':
        app.innerHTML = Auth.isHost ? Views.newTournament()
          : '<section><div class="empty">🎛 Creating tournaments is a host job — grab Paul or Chris. You can still <a href="#/players">form your own team</a>.</div></section>';
        break;
      case 'tournament': app.innerHTML = Views.tournamentPage(currentTournament()); break;
      case 'match':      app.innerHTML = Views.scorePage(currentTournament(), currentMatch()); break;
      default:
        // hosts get the control-room overview; competitors get their pass
        app.innerHTML = Auth.isHost ? Views.overview() : Views.competitorPass();
        if (Auth.isHost) Views.loadHqStandings();
    }
    $$('.topnav a').forEach(a => a.classList.toggle('on', a.dataset.nav === route.name ||
      (a.dataset.nav === 'home' && ['tournament', 'match'].includes(route.name))));
    settle();
  }

  const EVENT_HQ_PREFIX = ['junkyardolympics.com', 'www.junkyardolympics.com'].includes(window.location.hostname) ? '/hq-api' : '';
  async function eventHqRequest(path, options = {}) {
    if (!path.startsWith('/api/')) throw new Error('Invalid Event HQ route.');
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${Auth.token}`);
    const response = await fetch(`${EVENT_HQ_PREFIX}${path}`, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || data.error || 'Event HQ is unavailable.');
    return data;
  }

  async function photoVaultRequest(path, options = {}) {
    try {
      return await eventHqRequest(path, options);
    } catch (error) {
      if (error.message === 'Event HQ is unavailable.') throw new Error('Junkyard Constellation is unavailable.');
      throw error;
    }
  }

  let cannonSnapshot = null;
  let cannonScoring = null;
  let cannonRefreshTimer = null;

  function cannonTeam(snapshot, teamId) {
    return (snapshot.teams || []).find(team => team.id === teamId) || { id: teamId, name: 'Unknown team' };
  }

  function cannonTeamScore(snapshot, runId, teamId) {
    return (snapshot.cannonShots || []).filter(shot => shot.runId === runId && shot.teamId === teamId)
      .reduce((sum, shot) => sum + Number(shot.points || 0), 0);
  }

  function cannonClock(teamRun) {
    if (!teamRun?.deadlineAt || teamRun.state !== 'ACTIVE') return teamRun?.state || 'WAITING';
    const remaining = Math.max(0, Math.ceil((new Date(teamRun.deadlineAt).getTime() - Date.now()) / 1000));
    return `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
  }

  function renderCannonAdmin(snapshot, scoring) {
    const section = $('#cannon-admin'), status = $('#cannon-status'), content = $('#cannon-admin-content'), connection = $('#hq-connection');
    if (!section || !status || !content || !connection || !Auth.isHost) return;
    connection.textContent = 'CONNECTED';
    connection.className = 'chip chip-done';
    const teams = (snapshot.teams || []).filter(team => team.eventId === 'cannon');
    const cannonMembers = snapshot.teamMembers || [];
    const teamReady = teams.length > 0 && teams.every(team => cannonMembers.filter(member => member.teamId === team.id && member.active).length === 2);
    const run = [...(snapshot.cannonRuns || [])].reverse().find(candidate => candidate.eventId === 'cannon');

    if (!run) {
      section.dataset.cannonState = 'setup-required';
      status.innerHTML = teamReady
        ? '<b>SETUP REQUIRED</b> — teams are ready. Confirm the founder-approved v2 target table.'
        : '<b>SETUP REQUIRED</b> — every Cannon entrant must be on an exact two-person team first.';
      const enabled = scoring.targets.filter(target => target.enabled);
      content.innerHTML = `
        <div class="sec-head"><h3>Approved scoring v${scoring.version}</h3><span class="chip chip-rule">5:00 · UNLIMITED SHOTS</span></div>
        <div class="statchips">${enabled.map(target => `<span class="pchip">${esc(target.label)} <b>${target.points.toLocaleString()}</b></span>`).join('')}</div>
        <p class="muted small">Disabled for safety: ${scoring.targets.filter(target => !target.enabled).map(target => esc(target.label)).join(' · ')}</p>
        <p class="muted small">Teams ready: ${teams.map(team => `${esc(team.name)} (${cannonMembers.filter(member => member.teamId === team.id && member.active).length}/2)`).join(' · ') || 'none'}</p>
        <button class="btn btn-accent btn-lg" data-action="cannon-setup-save" ${teamReady ? '' : 'disabled'}>Confirm approved setup</button>`;
      return;
    }

    const assignments = (snapshot.cannonAssignments || []).filter(row => row.runId === run.id);
    const teamRuns = (snapshot.cannonTeamRuns || []).filter(row => row.runId === run.id);
    const active = teamRuns.find(row => row.state === 'ACTIVE');
    const targets = (snapshot.targets || []).filter(target => target.eventId === 'cannon');
    section.dataset.cannonState = active ? 'active' : 'ready';
    status.innerHTML = active
      ? `<b>LIVE · ${esc(cannonTeam(snapshot, active.teamId).name)}</b> — ${cannonClock(active)} remaining. Lane is ARMED/CLEAR.`
      : '<b>READY</b> — arm one team after the lane is physically clear.';

    const teamCards = assignments.map(assignment => {
      const team = cannonTeam(snapshot, assignment.teamId);
      const teamRun = teamRuns.find(row => row.teamId === team.id);
      const state = teamRun?.state || 'WAITING';
      const canArm = !active && !['COMPLETE', 'SAFETY_STOPPED'].includes(state);
      const canStart = !active && teamRun?.armedClear && state === 'PENDING';
      return `<div class="card">
        <div class="sec-head"><h3>${esc(team.name)}</h3><span class="chip chip-rule">${esc(state)}</span></div>
        <p class="pts">${cannonTeamScore(snapshot, run.id, team.id).toLocaleString()} pts</p>
        <div class="chiprow">
          <button class="btn btn-ghost btn-sm" data-action="cannon-arm" data-run="${esc(run.id)}" data-team="${esc(team.id)}" ${canArm ? '' : 'disabled'}>ARMED / CLEAR</button>
          <button class="btn btn-accent btn-sm" data-action="cannon-start" data-run="${esc(run.id)}" data-team="${esc(team.id)}" ${canStart ? '' : 'disabled'}>START 5:00</button>
        </div>
      </div>`;
    }).join('');

    const targetButtons = targets.map(target => `<label class="check">
      <input type="checkbox" class="cannon-carnage-target" value="${esc(target.id)}" ${active ? '' : 'disabled'}>
      <button class="btn btn-ghost btn-sm" data-action="cannon-hit" data-team-run="${esc(active?.id || '')}" data-target="${esc(target.id)}" ${active ? '' : 'disabled'}>${esc(target.name)} · ${Number(target.points).toLocaleString()}</button>
    </label>`).join('');

    content.innerHTML = `
      <div class="teamgrid">${teamCards || '<p class="muted">No Cannon teams are assigned.</p>'}</div>
      <div class="card">
        <div class="sec-head"><h3>Record one legal shot</h3><span class="chip ${active ? 'chip-live' : 'chip-rule'}">${active ? cannonClock(active) : 'WAITING'}</span></div>
        <div class="checkgrid">${targetButtons}</div>
        <div class="chiprow">
          <button class="btn btn-accent" data-action="cannon-carnage" data-team-run="${esc(active?.id || '')}" ${active ? '' : 'disabled'}>Record checked targets + 1,000 Carnage</button>
          <button class="btn btn-danger" data-action="cannon-safety-stop" data-team-run="${esc(active?.id || '')}" ${active ? '' : 'disabled'}>🛑 Safety Stop</button>
        </div>
        <p class="muted small">Tap a target button for a normal hit. For Carnage, check two or more separately labeled targets, then use the Carnage button.</p>
      </div>`;
  }

  async function loadCannonAdmin() {
    clearTimeout(cannonRefreshTimer);
    if (!Auth.isHost || parseRoute().name !== 'hq') return;
    try {
      const [snapshot, scoring] = await Promise.all([
        eventHqRequest('/api/state'),
        cannonScoring ? Promise.resolve(cannonScoring) : fetch('data/cannon-scoring-v2.json', { cache: 'no-store' }).then(response => {
          if (!response.ok) throw new Error('Approved Cannon scoring table is unavailable.');
          return response.json();
        }),
      ]);
      cannonSnapshot = snapshot;
      cannonScoring = scoring;
      renderCannonAdmin(snapshot, scoring);
    } catch (error) {
      const connection = $('#hq-connection'), status = $('#cannon-status');
      if (connection) { connection.textContent = 'OFFLINE'; connection.className = 'chip chip-live'; }
      if (status) status.innerHTML = `<b>EVENT HQ UNAVAILABLE</b> — ${esc(error.message)} All Cannon mutation controls remain locked.`;
    }
    cannonRefreshTimer = setTimeout(() => void loadCannonAdmin(), 1000);
  }

  async function cannonMutation(path, body, successMessage) {
    if (!Auth.isHost) throw new Error('Hosts only.');
    const result = await eventHqRequest(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    toast(successMessage, 'ok');
    await loadCannonAdmin();
    return result;
  }

  function photoStateLabel(photo) {
    return ({ PUBLISHED: '🏆 Approved for the screen', PENDING_REVIEW: '👀 Waiting for organizer review', PROCESSING: '⚙️ Preparing privately', REJECTED: 'Not selected for the screen', REMOVED: 'Removed', DELETED: 'Deleted' })[photo.state] || photo.state;
  }

  async function loadPhotoVault() {
    const list = $('#vault-list');
    if (!list) return;
    try {
      const data = await photoVaultRequest('/api/photos/mine');
      const photos = data.photos || [];
      list.innerHTML = photos.length ? photos.map(photo => `
        <div class="vault-item">
          <b>${esc(photoStateLabel(photo))}</b>
          <span class="muted small">${esc(new Date(photo.createdAt).toLocaleString())}</span>
          ${photo.removalRequestedAt ? '<span class="muted small">Removal requested</span>' : !['DELETED','REMOVED'].includes(photo.state) ? `<button class="btn btn-ghost btn-sm" data-action="photo-remove" data-id="${esc(photo.id)}">Request removal</button>` : ''}
        </div>`).join('') : '<p class="muted small">Nothing here yet. Your first photo will appear here privately after upload.</p>';
    } catch (error) {
      list.innerHTML = `<p class="muted small">${esc(error.message)}</p>`;
    }
  }

  async function submitPhotoVault() {
    const file = $('#vault-photo')?.files?.[0];
    const consent = $('#vault-consent')?.checked;
    const button = $('#vault-submit');
    const status = $('#vault-status');
    if (!file || !consent || !button || !status) return;
    button.disabled = true;
    status.textContent = 'Sending privately to Junkyard Constellation…';
    const body = new FormData();
    body.append('photo', file);
    body.append('names', $('#vault-names').value.trim());
    body.append('consentAccepted', 'true');
    body.append('consentVersion', 'junkyard-photo-consent-v1');
    try {
      await photoVaultRequest('/api/photos', { method: 'POST', body });
      status.textContent = '✅ Safely received. It is private until an organizer approves it.';
      $('#vault-photo').value = '';
      $('#vault-consent').checked = false;
      const preview = $('#vault-preview');
      preview.hidden = true;
      preview.removeAttribute('src');
      await loadPhotoVault();
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  }

  /* ---------- match flow ---------- */

  function startMatch(mid) {
    const t = currentTournament();
    const m = t && t.matches.find(x => x.id === mid);
    if (!t || !m || !Bracket.isReady(m)) return;

    const plan = Bracket.planStart(t, m);
    if (plan.stuck.length) {
      const lines = plan.stuck.map(s =>
        `${s.team.name}: ${s.names} currently playing in "${s.where}"`).join('\n');
      if (!confirm(`Heads up — players are mid-game and no free team is available on this leg:\n\n${lines}\n\nStart anyway?`)) {
        return;
      }
    }
    Bracket.applyStart(t, m, plan);
    plan.swaps.forEach(s => toast(s.note, 'warn'));
    const target = `#/m/${t.id}/${m.id}`;
    if (location.hash === target) render();
    else location.hash = target;
  }

  function finishMatch() {
    const t = currentTournament();
    const m = currentMatch();
    if (!t || !m || m.status !== 'live') return;
    if (m.scoreA === m.scoreB) {
      toast('It\'s tied — someone has to win! Keep playing.', 'error');
      return;
    }
    const r = t.rules;
    const hi = Math.max(m.scoreA, m.scoreB);
    const diff = Math.abs(m.scoreA - m.scoreB);
    if (hi < r.target && !confirm(`Neither team has reached ${r.target} yet. Finish anyway?`)) return;
    if (hi >= r.target && r.winBy > 0 && diff < r.winBy &&
        !confirm(`Rules say win by ${r.winBy} (current margin: ${diff}). Finish anyway?`)) return;

    const winnerId = m.scoreA > m.scoreB ? m.teamA : m.teamB;
    Bracket.finishMatch(t, m, winnerId);
    toast(`🏆 <b>${esc(Store.teamName(t, winnerId))}</b> takes it, ${m.scoreA}–${m.scoreB}!`, 'ok');
    if (t.status === 'complete') {
      Confetti.burst(220);
      toast(`🎉 <b>${esc(Store.teamName(t, t.placements.first))}</b> are the ${esc(t.name)} champions!`, 'ok');
    }
    location.hash = `#/t/${t.id}`;
  }

  /* ---------- click actions ---------- */

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const act = el.dataset.action;

    switch (act) {
      case 'photo-submit': {
        void submitPhotoVault();
        break;
      }
      case 'photo-refresh': {
        void loadPhotoVault();
        break;
      }
      case 'photo-remove': {
        if (!confirm('Request removal of this photo from the screen and vault review?')) break;
        void photoVaultRequest(`/api/photos/${encodeURIComponent(el.dataset.id)}/removal-request`, { method: 'POST' })
          .then(() => { toast('Removal requested.', 'ok'); return loadPhotoVault(); })
          .catch(error => toast(esc(error.message), 'error'));
        break;
      }
      /* players page */
      case 'add-players': {
        const input = $('#new-players');
        const n = Store.addPlayers(input.value.split(/[,\n;]+/).map(censorName));
        if (n) toast(`Added ${n} player${n > 1 ? 's' : ''}.`, 'ok');
        input.value = '';
        render();
        break;
      }
      case 'remove-player': {
        if (!Auth.isHost) { toast('🎛 Only hosts can remove players.', 'error'); break; }
        if (confirm(`Remove ${Store.playerName(el.dataset.id)} from the pool?`)) {
          Store.removePlayer(el.dataset.id);
          render();
        }
        break;
      }
      case 'create-team': {
        const raw = $('#team-name').value.trim();
        const ids = $$('.team-pick:checked').map(x => x.value);
        if (!raw) { toast('Give the team a name.', 'error'); break; }
        if (!ids.length) { toast('Pick at least one player.', 'error'); break; }
        // guests can form their own teams — exactly two players
        if (!Auth.isHost && ids.length !== 2) {
          toast('Teams you form yourself are 2 players — pick exactly two (hosts can make other sizes).', 'error');
          break;
        }
        const name = censorName(raw);
        // guest-formed teams wait for the partner (or a host) to confirm
        Store.addStaticTeam(name, ids, Auth.isHost ? {} : { pending: true, createdBy: Auth.name || '' });
        const cleaned = name === raw ? '' : ' (name cleaned up by the censor 🧼)';
        toast(Auth.isHost
          ? `Team <b>${esc(name)}</b> created.${cleaned}`
          : `Team <b>${esc(name)}</b> proposed${cleaned} — your partner (or a host) confirms it on this page. ⏳`, 'ok');
        render();
        break;
      }
      case 'confirm-team': {
        const t = Store.state.staticTeams.find(x => x.id === el.dataset.id);
        if (!t) break;
        const me = (Auth.name || '').toLowerCase();
        const isPartner = t.playerIds.some(pid => Store.playerName(pid).toLowerCase() === me) &&
                          me !== (t.createdBy || '').toLowerCase();
        if (!Auth.isHost && !isPartner) {
          toast('Only the other teammate (or a host) can confirm this team.', 'error');
          break;
        }
        Store.confirmStaticTeam(t.id);
        toast(`🤝 <b>${esc(t.name)}</b> is official!`, 'ok');
        render();
        break;
      }
      case 'remove-team': {
        const team = Store.state.staticTeams.find(t => t.id === el.dataset.id);
        const me = (Auth.name || '').toLowerCase();
        const mine = team && (team.playerIds.some(pid => Store.playerName(pid).toLowerCase() === me) ||
                              (team.createdBy || '').toLowerCase() === me);
        if (!Auth.isHost && !mine) { toast('You can only delete a team you\'re on (hosts can delete any).', 'error'); break; }
        Store.removeStaticTeam(el.dataset.id);
        render();
        break;
      }

      /* new tournament draft */
      case 'draft-game': {
        const d = Views.getDraft();
        d.gameIdx = Number(el.dataset.i);
        const g = GAME_PRESETS[d.gameIdx];
        d.target = g.target; d.winBy = g.winBy; d.notes = g.notes;
        render();
        break;
      }
      case 'draft-static': {
        const d = Views.getDraft();
        if (el.checked) d.staticIds.add(el.dataset.id);
        else d.staticIds.delete(el.dataset.id);
        d.randomTeams = []; d.bench = [];
        render();
        break;
      }
      case 'draft-shuffle': {
        Views.shuffleDraftTeams();
        render();
        break;
      }
      case 'draft-create': {
        const d = Views.getDraft();
        const teams = [];
        for (const id of d.staticIds) {
          const st = Store.state.staticTeams.find(t => t.id === id);
          if (st) teams.push({ name: st.name, playerIds: st.playerIds, kind: 'static' });
        }
        teams.push(...d.randomTeams);
        if (teams.length < 2) { toast('You need at least 2 teams to run a bracket.', 'error'); break; }
        const preset = GAME_PRESETS[d.gameIdx];
        const game = preset.name === 'Custom' ? (d.customGame.trim() || 'Custom Game') : preset.name;
        const t = Bracket.createTournament({
          name: d.name.trim() || `${game} Showdown`,
          game, icon: preset.icon,
          rules: { target: d.target, winBy: d.winBy, notes: d.notes },
          teamSize: d.teamSize,
          teams,
          format: d.format,
          seeded: !!d.seeded,
        });
        Views.resetDraft();
        toast(`🚀 <b>${esc(t.name)}</b> is underway — bracket drawn!`, 'ok');
        location.hash = `#/t/${t.id}`;
        break;
      }

      /* QR signup: password rides in the link, guest only types a name */
      case 'join-go': {
        const name = $('#j-name').value.trim();
        if (!name) { toast('Type your name first!', 'error'); break; }
        let pass = '';
        try { pass = decodeURIComponent(escape(atob(decodeURIComponent(el.dataset.code || '')))); } catch {}
        if (!pass) { toast('This signup link is broken — grab the host.', 'error'); break; }
        Auth.login(name, pass).then(s => {
          toast(`Welcome to the Junkyard Olympics, <b>${esc(s.name)}</b>! 🏆`, 'ok');
          Store.ensurePlayer(s.name);
          location.hash = s.role === 'host' ? '#/' : '#/games';
        }).catch(err => toast(esc(err.message), 'error'));
        break;
      }

      /* host QR poster generator — points at the main site (Chris's signup) */
      case 'qr-make': {
        const url = 'https://junkyardolympics.com/';
        const qr = qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        $('#qr-out').innerHTML = `
          <div class="qr-poster" id="qr-poster">
            <img class="qr-hero" src="assets/junkyard-hero.jpg" alt="">
            <h2>SCAN TO JOIN THE GAMES</h2>
            <div class="qr-code">${qr.createSvgTag({ cellSize: 6, margin: 2 })}</div>
            <p>Scan → type your name → compete. No email, no password. 🏆</p>
            <p class="qr-pass-line">🎶 JUKEBOX PASSWORD: ________________</p>
          </div>
          <div class="addrow" style="margin-top:10px">
            <input value="${esc(url)}" readonly onclick="this.select()">
            <button class="btn btn-ghost" data-action="qr-print">🖨 Print poster</button>
          </div>`;
        break;
      }
      case 'qr-print': {
        window.print();
        break;
      }

      /* event signup: Chris's flow — players enter the games they'll play */
      case 'toggle-game': {
        const p = Store.ensurePlayer(Auth.name);
        if (!p) { toast('Log in first!', 'error'); break; }
        const on = Store.toggleSignup(p.id, el.dataset.game);
        toast(on ? `🎟 You're in for <b>${esc(el.dataset.game)}</b>!`
                 : `Backed out of ${esc(el.dataset.game)}.`, 'ok');
        render();
        break;
      }

      /* verified Event HQ Cannon controls */
      case 'cannon-setup-save': {
        if (!Auth.isHost || !cannonScoring || !confirm('Confirm the approved v2 target table and lock Cannon setup for this event?')) break;
        const targets = cannonScoring.targets.filter(target => target.enabled)
          .map(target => ({ name: target.label, points: target.points, jackpot: !!target.jackpot }));
        void cannonMutation('/api/cannon/setup', {
          confirmed: true,
          mode: 'timed',
          durationSeconds: cannonScoring.durationSeconds,
          carnageBonus: cannonScoring.carnageBonus,
          targets,
        }, '💥 Cannon setup confirmed.').catch(error => toast(esc(error.message), 'error'));
        break;
      }
      case 'cannon-arm': {
        if (!Auth.isHost || !confirm('Is the lane physically clear and ready to arm?')) break;
        void cannonMutation(`/api/cannon/runs/${encodeURIComponent(el.dataset.run)}/teams/${encodeURIComponent(el.dataset.team)}/arm`, { clear: true }, 'Lane marked ARMED / CLEAR.')
          .catch(error => toast(esc(error.message), 'error'));
        break;
      }
      case 'cannon-start': {
        if (!Auth.isHost || !confirm('Start this team’s single five-minute build-and-shoot window now?')) break;
        void cannonMutation(`/api/cannon/runs/${encodeURIComponent(el.dataset.run)}/teams/${encodeURIComponent(el.dataset.team)}/start`, {}, '⏱ Five-minute Cannon run started!')
          .catch(error => toast(esc(error.message), 'error'));
        break;
      }
      case 'cannon-hit': {
        if (!Auth.isHost || !el.dataset.teamRun || !el.dataset.target) break;
        void cannonMutation(`/api/cannon/team-runs/${encodeURIComponent(el.dataset.teamRun)}/shots`, { targetIds: [el.dataset.target] }, 'Hit recorded.')
          .catch(error => toast(esc(error.message), 'error'));
        break;
      }
      case 'cannon-carnage': {
        if (!Auth.isHost || !el.dataset.teamRun) break;
        const targetIds = $$('.cannon-carnage-target:checked').map(input => input.value);
        if (targetIds.length < 2) { toast('Carnage requires two or more separately labeled targets from one legal shot.', 'error'); break; }
        if (!confirm(`Record ${targetIds.length} targets plus the 1,000-point Carnage bonus?`)) break;
        void cannonMutation(`/api/cannon/team-runs/${encodeURIComponent(el.dataset.teamRun)}/shots`, { targetIds, carnage: true }, '💥 CARNAGE! +1,000 recorded.')
          .catch(error => toast(esc(error.message), 'error'));
        break;
      }
      case 'cannon-safety-stop': {
        if (!Auth.isHost || !el.dataset.teamRun || !confirm('SAFETY STOP: freeze the active timer and reject all further shots?')) break;
        const reason = prompt('Safety Stop reason (required):', 'Lane no longer clear')?.trim();
        if (!reason) { toast('Safety Stop reason is required.', 'error'); break; }
        void cannonMutation(`/api/cannon/team-runs/${encodeURIComponent(el.dataset.teamRun)}/safety-stop`, { reason }, '🛑 Safety Stop recorded. Timer and scoring are frozen.')
          .catch(error => toast(esc(error.message), 'error'));
        break;
      }

      /* auth */
      case 'auth-login': {
        const name = $('#a-name').value.trim();
        const pass = $('#a-pass').value;
        if (!name || !pass) { toast('Enter your name and the party password.', 'error'); break; }
        Auth.login(name, pass).then(s => {
          toast(s.role === 'host' ? `🎛 Welcome, host <b>${esc(s.name)}</b>!` : `Welcome, <b>${esc(s.name)}</b>! 🏆`, 'ok');
          // guests go straight to step 2: pick your events
          if (s.role !== 'host') { Store.ensurePlayer(s.name); location.hash = '#/games'; }
          render();
        }).catch(err => toast(esc(err.message), 'error'));
        break;
      }
      case 'auth-logout': {
        e.preventDefault();
        if (Auth.ok && confirm('Log out?')) { Auth.logout(); render(); }
        break;
      }

      /* host/admin tools */
      case 'reopen-match': {
        const t = currentTournament();
        const m = t && t.matches.find(x => x.id === el.dataset.mid);
        if (!t || !m) break;
        const err = Bracket.reopenMatch(t, m);
        if (err) { toast(esc(err), 'error'); break; }
        toast('Match reopened — fix the score and finish it again. 🎛', 'ok');
        location.hash = `#/m/${t.id}/${m.id}`;
        render();
        break;
      }
      case 'adm-restart': {
        const t = currentTournament();
        if (t && confirm(`Restart "${t.name}"? All results are wiped and the bracket is redrawn with the same teams.`)) {
          Bracket.restart(t);
          toast('Bracket redrawn from scratch. ♻', 'ok');
          render();
        }
        break;
      }
      case 'adm-swap-slots': {
        const t = currentTournament();
        if (!t) break;
        const err = Bracket.swapSlots(t, $('#adm-slot-a').value, $('#adm-slot-b').value);
        if (err) { toast(esc(err), 'error'); break; }
        toast('Teams swapped to their new legs. ↔', 'ok');
        render();
        break;
      }
      case 'adm-swap-players': {
        const t = currentTournament();
        if (!t) break;
        const err = Bracket.movePlayer(t, $('#adm-p-a').value, $('#adm-p-b').value);
        if (err) { toast(esc(err), 'error'); break; }
        toast('Players reassigned. 🔁', 'ok');
        render();
        break;
      }

      /* tournament & match */
      case 'start-match': startMatch(el.dataset.mid); break;
      case 'finish-match': finishMatch(); break;
      case 'score-add': {
        const t = currentTournament();
        const m = currentMatch();
        if (!t || !m || m.status !== 'live') break;
        const key = el.dataset.side === 'A' ? 'scoreA' : 'scoreB';
        m[key] = Math.max(0, m[key] + Number(el.dataset.n));
        Bracket.touchMatch(t, m);
        Store.save();
        render();
        break;
      }
      case 'del-tournament': {
        const t = currentTournament();
        if (t && confirm(`Delete "${t.name}" and all its matches? This can't be undone.`)) {
          Store.removeTournament(t.id);
          location.hash = '#/';
        }
        break;
      }

      /* data tools */
      case 'export-data': {
        const blob = new Blob([Store.exportJSON()], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'bracket-attack-backup.json';
        a.click();
        URL.revokeObjectURL(a.href);
        break;
      }
      case 'reset-all': {
        if (confirm('Wipe ALL players, teams and tournaments?') &&
            confirm('Really sure? There is no undo — this clears every synced device too.')) {
          Store.resetAll();
          render();
        }
        break;
      }

      /* live sync */
      case 'sync-join': {
        const val = $('#sync-room').value;
        if (val.trim()) {
          Sync.setRoom(val);
          toast(`Joined room <b>${esc(Sync.room)}</b>.`, 'ok');
          render();
        }
        break;
      }
      case 'sync-toggle': {
        Sync.setEnabled(!Sync.enabled);
        render();
        break;
      }
    }
  });

  /* ---------- field changes (new-tournament form & import) ---------- */

  document.addEventListener('change', (e) => {
    const el = e.target;

    if (el.id === 'vault-photo') {
      const file = el.files?.[0];
      const preview = $('#vault-preview');
      const status = $('#vault-status');
      if (!file) {
        preview.hidden = true;
        $('#vault-submit').disabled = true;
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        el.value = '';
        preview.hidden = true;
        status.textContent = 'That photo is over 8 MiB. Choose a smaller one.';
        $('#vault-submit').disabled = true;
        return;
      }
      preview.src = URL.createObjectURL(file);
      preview.hidden = false;
      status.textContent = 'Preview ready. Confirm consent to send it privately.';
      $('#vault-submit').disabled = !$('#vault-consent').checked;
      return;
    }
    if (el.id === 'vault-consent') {
      $('#vault-submit').disabled = !(el.checked && $('#vault-photo')?.files?.[0]);
      return;
    }

    if (el.id === 'import-file') {
      const file = el.files[0];
      if (!file) return;
      file.text().then(txt => {
        if (!confirm('Importing replaces everything currently stored. Continue?')) return;
        try {
          Store.importJSON(txt);
          toast('Backup imported.', 'ok');
          render();
        } catch (err) {
          toast('Import failed: ' + esc(err.message), 'error');
        }
      });
      return;
    }

    const field = el.dataset.field;
    if (!field) return;
    const d = Views.getDraft();
    if (field === 'target' || field === 'winBy' || field === 'teamSize') {
      d[field] = Number(el.value);
      if (field === 'teamSize') { d.randomTeams = []; d.bench = []; render(); }
    } else {
      d[field] = el.value;
      if (field === 'format' || field === 'seeded') render();
    }
  });

  // Sync calls this when remote changes arrive. Skip the redraw while the
  // user is typing so the refresh doesn't steal their input focus.
  window.App = {
    rerender() {
      const a = document.activeElement;
      if (a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName)) return;
      render();
    },
  };

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const a = document.activeElement;
    if (a === $('#j-name')) { const b = $('[data-action="join-go"]'); if (b) b.click(); }
    if (a === $('#a-pass')) { const b = $('[data-action="auth-login"]'); if (b) b.click(); }
    if (a === $('#qr-pass')) { const b = $('[data-action="qr-make"]'); if (b) b.click(); }
  });

  addEventListener('hashchange', render);
  render();
})();
