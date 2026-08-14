import { api } from './api.js';
import { buildParticipantFeed } from './participant-feed.js';
import { createCallCountdownTicker } from './call-countdown.js';
import { esc, initShell } from './ui.js';

initShell('station');
const $ = selector => document.querySelector(selector);
const stationId = decodeURIComponent(location.pathname.split('/').filter(Boolean).at(-1) ?? '');
let match = null;
const countdown = createCallCountdownTicker({ render: text => { $('#station-countdown').textContent = text; } });

function matchupMarkup(current) {
  return `<div><strong>${esc(current.teamA.name)}</strong><span>${esc(current.teamA.names.join(' + ') || 'Players pending')}</span></div><b>vs</b><div><strong>${esc(current.teamB.name)}</strong><span>${esc(current.teamB.names.join(' + ') || 'Players pending')}</span></div>`;
}

function showMessage(title, instruction, message = '') {
  $('#station-title').textContent = title;
  $('#station-instruction').textContent = instruction;
  $('#station-match').hidden = true;
  $('#station-status').textContent = message;
  countdown.stop();
}

async function loadStation() {
  if (api.demo) {
    showMessage('Demo station', 'Demo mode cannot check in a real team.', 'Use the live station QR during the event.');
    return;
  }
  if (!api.hasParticipantIdentity()) {
    showMessage('Competitor pass needed', 'Sign up or continue your saved pass on this phone before checking in.', 'No check-in was recorded.');
    $('#station-back').href = '/';
    $('#station-back').textContent = 'Go to signup';
    return;
  }
  try {
    const [me, state] = await Promise.all([api.getMe(), api.getState()]);
    const station = state.stations.find(item => item.id === stationId);
    if (!station) {
      showMessage('Unknown station', 'This QR does not match a configured Junkyard station.', 'Ask Chris or Paul for the correct station sign.');
      return;
    }
    const stationEvent = state.events.find(event => event.id === station.eventId);
    $('#station-title').textContent = station.name;
    $('#station-event').textContent = stationEvent?.name ?? 'Official field game';
    const feed = buildParticipantFeed({ liveData: { ...me, state, standings: [] } });
    const current = feed.activeMatch;
    if (!current || current.stationId !== stationId) {
      showMessage(station.name, 'You do not have a called match at this station right now.', 'No check-in was recorded.');
      return;
    }
    match = current;
    const status = String(current.status).toUpperCase();
    if (status !== 'CALLED') {
      showMessage(station.name, status === 'ACTIVE' ? 'Both teams are checked in. Your match is active.' : 'This match no longer needs station check-in.', 'Return to your competitor pass for the next action.');
      return;
    }
    $('#station-instruction').textContent = `You are checking in ${current.myTeamId === current.teamA.id ? current.teamA.name : current.teamB.name}. One teammate check-in represents the whole team.`;
    $('#station-event').textContent = `${current.eventName} · Round ${current.round}`;
    $('#station-matchup').innerHTML = matchupMarkup(current);
    $('#station-match').hidden = false;
    $('#station-status').textContent = '';
    countdown.show(current);
  } catch (error) {
    showMessage('Check-in unavailable', 'Your saved pass or live match state could not be verified.', error.message || 'No check-in was recorded.');
  }
}

$('#station-check-in').addEventListener('click', async () => {
  if (!match) return;
  const button = $('#station-check-in');
  button.disabled = true;
  button.textContent = 'Checking in…';
  $('#station-status').textContent = '';
  try {
    const updated = await api.checkInMatch(match.id);
    const status = String(updated.status).toLowerCase();
    $('#station-status').textContent = status === 'active'
      ? 'Both teams are here. Match active — go play!'
      : 'Your team is checked in. Waiting for the other team.';
    button.hidden = true;
    countdown.stop();
  } catch (error) {
    $('#station-status').textContent = error.message;
    button.disabled = false;
    button.textContent = "I'm here — check in my team";
  }
});

window.addEventListener('pagehide', countdown.stop);
await loadStation();
