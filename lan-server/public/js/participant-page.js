import { api } from './api.js';
import { demo } from './demo-data.js';
import { esc, initShell, toast } from './ui.js';
import { buildParticipantFeed } from './participant-feed.js';
import { createCallCountdownTicker } from './call-countdown.js';
import { initPhotoUpload } from './photo-upload.js';

initShell('participant');
const $ = selector => document.querySelector(selector);
let feed;
let liveState;
const countdown = createCallCountdownTicker({ render: text => { $('#call-countdown').textContent = text; } });
const stopPhotoUpload = initPhotoUpload({ api, demo: api.demo });

function namesMarkup(match) {
  if (feed.mode === 'demo') {
    return `<div><strong>${esc(match.team)}</strong><span>${esc(match.players)}</span></div><b>vs</b><div><strong>${esc(match.opponent)}</strong><span>${esc(match.opponents)}</span></div>`;
  }
  return `<div><strong>${esc(match.teamA.name)}</strong><span>${esc(match.teamA.names.join(' + ') || 'Players pending')}</span></div><b>vs</b><div><strong>${esc(match.teamB.name)}</strong><span>${esc(match.teamB.names.join(' + ') || 'Players pending')}</span></div>`;
}

function renderCalledMatch(match) {
  const card = $('#do-this-now');
  $('#call-empty').hidden = Boolean(match);
  card.hidden = !match;
  countdown.stop();
  if (!match) return;
  const station = feed.mode === 'demo' ? match.station : match.stationName;
  const status = feed.mode === 'demo' ? 'CALLED' : String(match.status).toUpperCase();
  $('#call-station').textContent = station;
  $('#call-event').textContent = feed.mode === 'demo' ? match.event : `${match.eventName} · Round ${match.round}`;
  $('#call-matchup').innerHTML = namesMarkup(match);
  $('#call-countdown-row').hidden = status !== 'CALLED';
  $('#report-result-actions').hidden = true;
  $('#confirm-result-actions').hidden = true;
  $('#match-mutation-status').textContent = '';

  if (status === 'CALLED') {
    $('#call-heading').innerHTML = `Report to <span id="call-station">${esc(station)}</span>`;
    $('#call-instruction').textContent = 'Your match has been called. Go to the station and scan the printed QR sign.';
    $('#match-action-status').textContent = 'When you arrive, one teammate scans the station sign to check in your whole team.';
    countdown.show(match, { demo: feed.mode === 'demo' });
    return;
  }
  if (status === 'ACTIVE') {
    $('#call-heading').textContent = `Record the result at ${station}`;
    $('#call-instruction').textContent = 'Your match is active. When it ends, report which team won.';
    $('#match-action-status').textContent = 'One player reports the winner. Someone on the opposing team confirms.';
    $('#report-team-a').textContent = `Report ${match.teamA.name} won`;
    $('#report-team-b').textContent = `Report ${match.teamB.name} won`;
    $('#report-result-actions').hidden = false;
    return;
  }
  if (status === 'AWAITING_CONFIRMATION') {
    const winner = match.reportedWinnerId === match.teamA.id ? match.teamA : match.teamB;
    const reporterIsMyTeam = match.reporterTeamId === match.myTeamId;
    $('#call-heading').textContent = reporterIsMyTeam ? 'Waiting for opponent confirmation' : 'Confirm the reported result';
    $('#call-instruction').textContent = `${winner.name} was reported as the winner.`;
    $('#match-action-status').textContent = reporterIsMyTeam
      ? 'Someone from the other team must confirm or dispute this result.'
      : 'Confirm if this is correct, or dispute it for organizer review.';
    $('#confirm-result-actions').hidden = reporterIsMyTeam;
    return;
  }
  $('#call-heading').textContent = 'Organizer review required';
  $('#call-instruction').textContent = 'The teams disagreed about this result.';
  $('#match-action-status').textContent = 'Chris or Paul will resolve the dispute. No further participant action is needed.';
}

function renderFeed() {
  document.body.dataset.state = feed.mode;
  $('#demo-banner').hidden = feed.mode !== 'demo';
  $('#greeting').textContent = feed.mode === 'empty' ? 'Your pass is not on this phone.' : `Hey, ${feed.name}.`;
  $('#progress-count').textContent = `${feed.progress.complete} of ${feed.progress.total}`;
  const percent = feed.progress.total ? Math.min(100, Math.round(feed.progress.complete / feed.progress.total * 100)) : 0;
  $('#progress-bar').style.width = `${percent}%`;
  renderCalledMatch(feed.activeMatch);

  $('#up-next-list').innerHTML = feed.events.length ? feed.events.map(event => `<article class="event-feed-card"><span class="scrap-tab" aria-hidden="true"></span><div><strong>${esc(event.name)}</strong><span>${esc(event.status ?? (event.kind === 'CANNON' || event.kind === 'cannon' ? 'Cannon entry confirmed' : 'Entered · wait for your call'))}</span></div><span class="ready-tag">${/complete/i.test(event.status ?? '') ? 'DONE' : 'READY'}</span></article>`).join('') : '<p class="empty-copy">No events joined yet. Ask an organizer if you need to change your entries.</p>';

  $('#results-list').innerHTML = feed.results.length ? feed.results.map(result => {
    if (feed.mode === 'demo') return `<article class="result-card"><strong>${esc(result.name)}</strong><span>${esc(result.status)}</span></article>`;
    const won = result.winnerId === result.myTeamId;
    return `<article class="result-card"><strong>${esc(result.eventName)} · Round ${esc(result.round)}</strong><span>${won ? 'Win recorded' : 'Match complete'}</span></article>`;
  }).join('') : '<p class="empty-copy">No completed results yet. Finished matches will stack up here.</p>';

  $('#standings-list').innerHTML = feed.standings.length ? feed.standings.slice(0, 5).map((row, index) => `<li><span class="standing-rank">${esc(row.rank ?? index + 1)}</span><span><strong>${esc(row.displayName ?? row.name)}</strong><small>${row.eligible === false ? 'Needs Cannon + 3 field finishes' : 'Podium eligible'}</small></span><b>${esc(row.total ?? row.points ?? 0)} pts</b></li>`).join('') : '<li class="empty-copy">No official placements yet. Standings appear after results are confirmed.</li>';

  const people = (liveState?.participants ?? []).filter(person => person.id !== liveState?.participant?.id && person.active !== 0);
  $('#flair-person').innerHTML = people.map(person => `<option value="${esc(person.id)}">${esc(person.displayName)}</option>`).join('');
  $('#open-flair').disabled = feed.mode === 'empty' || (feed.mode === 'live' && people.length === 0);
}

async function loadFeed() {
  if (api.demo) {
    liveState = { participants: demo.participants.map((name, index) => ({ id: `demo-${index}`, displayName: name, active: 1 })) };
    feed = buildParticipantFeed({ demoMode: true, demoData: { ...demo, me: { ...demo.me, name: localStorage.getItem('jo-demo-name') || demo.me.name } } });
    renderFeed();
    return;
  }
  try {
    const [me, state, championship, flair] = await Promise.all([api.getMe(), api.getState(), api.getChampionshipStandings(), api.getFlairStandings()]);
    liveState = { ...state, participant: me.participant };
    const myFlair = (flair.standings ?? []).find(row => row.participantId === me.participant.id)?.total ?? 0;
    feed = buildParticipantFeed({ liveData: { ...me, state, standings: championship.standings ?? [], flair: myFlair } });
  } catch (error) {
    feed = buildParticipantFeed();
    $('#call-empty').innerHTML = '<b>No competitor pass found.</b><span>Sign up on this phone, then your live calls and results will appear here.</span><a class="secondary-action" href="/">Go to signup</a>';
  }
  renderFeed();
}

$('#open-flair').addEventListener('click', () => {
  const form = $('#flair-form');
  form.hidden = !form.hidden;
  if (!form.hidden) $('#flair-person').focus();
});

$('#send-flair').addEventListener('click', async () => {
  if (feed.mode === 'demo') {
    toast('Demo only — no live Flair was recorded.');
    return;
  }
  try {
    await api.giveFlair($('#flair-person').value, $('#flair-category').value);
    $('#flair-status').textContent = 'Flair prop added to the pile.';
  } catch (error) {
    $('#flair-status').textContent = error.message;
  }
});

async function runMatchMutation(button, mutation, { dispute = false } = {}) {
  if (!feed?.activeMatch || feed.mode !== 'live') return;
  const controls = [...document.querySelectorAll('#match-action-panel button')];
  controls.forEach(control => { control.disabled = true; });
  const original = button.textContent;
  button.textContent = 'Saving…';
  let failure = null;
  try {
    await mutation(feed.activeMatch);
  } catch (error) {
    if (!dispute) failure = error;
  }
  await loadFeed();
  if (failure) $('#match-mutation-status').textContent = failure.message;
  else if (feed.activeMatch) $('#match-mutation-status').textContent = dispute ? 'Dispute sent to Chris and Paul.' : '';
  controls.forEach(control => { control.disabled = false; });
  button.textContent = original;
}

$('#report-team-a').addEventListener('click', event => runMatchMutation(event.currentTarget, match => api.reportResult(match.id, match.teamA.id)));
$('#report-team-b').addEventListener('click', event => runMatchMutation(event.currentTarget, match => api.reportResult(match.id, match.teamB.id)));
$('#confirm-result').addEventListener('click', event => runMatchMutation(event.currentTarget, match => api.confirmResult(match.id, true)));
$('#dispute-result').addEventListener('click', event => runMatchMutation(event.currentTarget, match => api.confirmResult(match.id, false), { dispute: true }));

$('#reset-device').addEventListener('click', () => {
  if (!confirm('Reset this device? Your saved competitor pass will be removed.')) return;
  api.signOut();
  localStorage.removeItem('jo-demo-name');
  location.href = '/';
});

window.addEventListener('pagehide', () => { countdown.stop(); stopPhotoUpload(); });

await loadFeed();
