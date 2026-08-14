import { api } from './api.js';
import { demo } from './demo-data.js';
import { initShell, esc } from './ui.js';
import { advanceToEvents, canEnter, cannonId, createSignupFlow, toggleEvent } from './signup-flow.js';

initShell('signup');
const $ = selector => document.querySelector(selector);
let flow;
let signupInFlight = false;
let signupCompleted = false;

async function showExistingIdentity() {
  if (api.demo || !api.hasParticipantIdentity()) return false;
  try {
    const me = await api.getMe();
    const name = me.participant.displayName;
    $('#existing-identity-name').textContent = name;
    $('#continue-existing-name').textContent = name;
    $('#signup').hidden = true;
    $('#existing-identity').hidden = false;
    return true;
  } catch {
    api.signOut();
    $('#name-status').textContent = 'The saved competitor pass was no longer valid. You can sign up again on this phone.';
    return false;
  }
}

function renderEvents() {
  const required = cannonId(flow);
  $('#event-list').innerHTML = flow.events.map((event, index) => {
    const selected = flow.selected.has(event.id);
    const cannon = event.id === required;
    return `<label class="event-choice ${selected ? 'selected' : ''} ${cannon ? 'cannon-choice' : ''}" for="event-${index}">
      <input id="event-${index}" type="checkbox" value="${esc(event.id)}" ${selected ? 'checked' : ''}>
      <span class="event-scrap-icon" aria-hidden="true">${cannon ? '🔥' : ['⚙', '◆', '●', '✦'][index % 4]}</span>
      <span class="event-choice-copy"><strong>${esc(event.name)}</strong><small>${cannon ? 'Required for championship podium' : event.playMode === 'CASUAL' ? 'Casual play · tell us you are interested' : 'Scored field event · tap to join'}</small></span>
      <span class="event-check" aria-hidden="true">${selected ? '✓' : '+'}</span>
    </label>`;
  }).join('');
  $('#enter-yard').disabled = !canEnter(flow);
}

async function loadEvents() {
  try {
    const source = api.demo ? { events: demo.events } : await api.getEvents();
    flow = createSignupFlow(source.events ?? []);
  } catch (error) {
    flow = createSignupFlow([]);
    $('#name-status').textContent = `Events could not be loaded. ${error.message}`;
    $('#pick-events').disabled = true;
  }
}

$('#pick-events').addEventListener('click', () => {
  try {
    flow = advanceToEvents(flow, $('#displayName').value);
    $('#name-status').textContent = '';
    $('#signup-step-name').hidden = true;
    $('#signup-step-events').hidden = false;
    renderEvents();
    $('#events-title').focus();
  } catch (error) {
    $('#name-status').textContent = error.message;
    $('#displayName').focus();
  }
});

$('#displayName').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    $('#pick-events').click();
  }
});

$('#edit-name').addEventListener('click', () => {
  $('#signup-step-events').hidden = true;
  $('#signup-step-name').hidden = false;
  $('#displayName').focus();
});

$('#switch-person').addEventListener('click', async () => {
  if (!confirm('Switch person on this phone? This removes only the saved pass from this browser. It does not delete the competitor or results.')) return;
  api.signOut();
  $('#existing-identity').hidden = true;
  $('#signup').hidden = false;
  $('#identity-status').textContent = '';
  if (!flow) await loadEvents();
  $('#displayName').focus();
});

$('#event-list').addEventListener('change', event => {
  if (!event.target.matches('input[type="checkbox"]')) return;
  flow = toggleEvent(flow, event.target.value);
  renderEvents();
});

$('#signup').addEventListener('submit', async event => {
  event.preventDefault();
  if (signupInFlight || signupCompleted || api.hasParticipantIdentity()) return;
  if (!canEnter(flow)) {
    $('#form-status').textContent = 'Choose Junkyard Cannon before entering the yard.';
    return;
  }
  const button = $('#enter-yard');
  signupInFlight = true;
  button.disabled = true;
  button.textContent = 'Saving your pass…';
  $('#form-status').textContent = '';
  try {
    if (api.demo) {
      localStorage.setItem('jo-demo-name', flow.displayName);
      $('#open-dashboard').href = '/participant.html?demo=1';
      signupCompleted = true;
    } else {
      const result = await api.signup(flow.displayName, [...flow.selected]);
      signupCompleted = true;
      if (result.recoveryRequired) {
        $('#form-status').textContent = result.recoveryMessage;
        $('#open-dashboard').hidden = true;
      }
    }
    $('#signup-step-events').hidden = true;
    $('#signup-confirmation').hidden = false;
    $('#saved-title').focus();
  } catch (error) {
    signupInFlight = false;
    $('#form-status').textContent = error.message;
    button.disabled = false;
    button.innerHTML = 'Enter the Junkyard <span aria-hidden="true">→</span>';
  }
});

if (!(await showExistingIdentity())) await loadEvents();
