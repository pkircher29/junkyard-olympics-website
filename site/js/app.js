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

      /* LAN control-tower bridge */
      case 'hq-save': {
        const v = $('#hq-url').value.trim().replace(/\/+$/, '');
        if (v && !/^https?:\/\//.test(v)) { toast('URL needs to start with http:// or https://', 'error'); break; }
        Store.setSetting('hqUrl', v);
        toast(v ? '🎪 Event HQ linked — every synced device gets it.' : 'Event HQ link cleared.', 'ok');
        location.hash = '#/';
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
