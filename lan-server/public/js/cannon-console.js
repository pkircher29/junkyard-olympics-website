const q = selector => document.querySelector(selector);
const mutationSelector = '[data-mutation] button, [data-mutation] input, [data-mutation] select, [data-mutation] textarea, button[data-mutation]';
let authorized = false;
let operational = false;
let configured = false;
let api;
let getOrganizerToken;
let state;

export function lockMutations(reason = '') {
  document.querySelectorAll(mutationSelector).forEach(control => { control.disabled = !(authorized && operational && configured); });
  if (reason) q('#auth-status').textContent = reason;
}
const escapeHtml = value => { const node = document.createElement('span'); node.textContent = String(value ?? ''); return node.innerHTML; };
const option = (value, label) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
const selectedRun = () => state.cannonRuns.find(run => run.id === q('#run-select').value);
const assignments = () => state.cannonAssignments.filter(item => item.runId === q('#run-select').value);
const selectedAssignment = () => assignments().find(item => item.teamId === q('#team-select').value);
const team = id => state.teams.find(item => item.id === id);
const participant = id => state.participants.find(item => item.id === id);

function show(message, error = false) { q('#setup-status').textContent = message; q('#setup-status').className = error ? 'warning' : 'notice'; }
function renderTargets(run) {
  const targets = state.targets.filter(target => target.eventId === run.eventId);
  q('#targets').innerHTML = targets.length ? targets.map(target => `<label><input type="checkbox" name="target" value="${escapeHtml(target.id)}"> ${escapeHtml(target.name)} · ${escapeHtml(target.points)}${target.jackpot ? ' · JACKPOT' : ''}</label>`).join('') : '<p class="warning">No targets configured for this Cannon event.</p>';
  return targets.length;
}
function renderTeamChoices() {
  q('#team-select').innerHTML = assignments().map(item => option(item.teamId, team(item.teamId)?.name ?? item.teamId)).join('');
  renderShooterLane();
}
function renderShooterLane() {
  const assignment = selectedAssignment();
  const members = state.teamMembers.filter(member => member.teamId === assignment?.teamId && member.active).map(member => participant(member.participantId)).filter(Boolean);
  q('#shooter-select').innerHTML = members.map(person => option(person.id, person.displayName)).join('');
  q('#lane-select').innerHTML = assignment ? option(assignment.laneId, assignment.laneId) : '';
  q('#configuration').innerHTML = assignment ? `<p><b>${escapeHtml(team(assignment.teamId)?.name ?? assignment.teamId)}</b><br>Lane: ${escapeHtml(assignment.laneId)}<br>Shooters: ${members.map(person => escapeHtml(person.displayName)).join(', ') || 'none'}</p>` : '<p>No assignment selected.</p>';
  configured = Boolean(selectedRun() && assignment && members.length && state.targets.some(target => target.eventId === selectedRun().eventId));
  if (!members.length) show('Setup needed: selected run assignment has no active team member to choose as shooter.', true);
  lockMutations();
}
function render() {
  const cannonEvents = state.events.filter(event => event.kind === 'CANNON');
  if (!cannonEvents.length) { configured = false; show('Setup needed: no Cannon event exists.', true); return lockMutations(); }
  if (!state.cannonRuns.length) { configured = false; show('Setup needed: no Cannon run exists. Form Cannon teams, configure targets, then create a run with team/lane assignments.', true); return lockMutations(); }
  q('#run-select').innerHTML = state.cannonRuns.map(run => option(run.id, `${state.events.find(event => event.id === run.eventId)?.name ?? run.eventId} · ${run.id.slice(0, 8)}`)).join('');
  const run = selectedRun();
  if (!assignments().length) { configured = false; show('Setup needed: selected Cannon run has no team/lane assignments.', true); return lockMutations(); }
  const targetCount = renderTargets(run);
  renderTeamChoices();
  if (!targetCount) { configured = false; show('Setup needed: selected Cannon run event has no configured targets.', true); }
  else if (configured) show('Cannon run, team, shooter, lane, and targets loaded from authoritative state.');
  lockMutations();
}

lockMutations('Organizer authorization required; all scoring controls are locked.');
try {
  const authModule = await import('./auth.js'); getOrganizerToken = authModule.getOrganizerToken;
  ({ api } = await import('./api.js'));
  authorized = Boolean(getOrganizerToken());
  if (api.demo) q('#auth-status').textContent = 'Demo mode is inert. Shot saving is disabled.';
  else if (authorized) { operational = true; q('#auth-status').textContent = 'Organizer credential loaded for this tab.'; }
  state = await api.getState();
  render();
} catch (error) {
  operational = configured = false;
  lockMutations(`Cannon console locked: ${error.message || 'credential/storage/state error'}`);
  show('Could not load authoritative Cannon configuration. No shot can be saved.', true);
}

q('#run-select').addEventListener('change', () => { const count = renderTargets(selectedRun()); renderTeamChoices(); if (!count) { configured = false; show('Setup needed: selected Cannon run event has no configured targets.', true); } lockMutations(); });
q('#team-select').addEventListener('change', renderShooterLane);
q('#kind-select').addEventListener('change', () => { q('#sequence').max = q('#kind-select').value === 'practice' ? '10' : '20'; if (+q('#sequence').value > +q('#sequence').max) q('#sequence').value = q('#sequence').max; });
q('#cannon-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!(authorized && operational && configured) || api.demo) return;
  const run = selectedRun(), assignment = selectedAssignment();
  const body = { teamId: assignment.teamId, shooterId: q('#shooter-select').value, laneId: assignment.laneId, kind: q('#kind-select').value, sequence: Number(q('#sequence').value), targetIds: [...document.querySelectorAll('input[name="target"]:checked')].map(input => input.value), carnage: q('#carnage').checked };
  try { const result = await api.organizerRequest(`/api/cannon/runs/${encodeURIComponent(run.id)}/shots`, { method: 'POST', body }); show(`Saved shot ${result.shot.id}: ${result.shot.total} points.`); q('#sequence').value = String(Math.min(Number(q('#sequence').max), Number(q('#sequence').value) + 1)); document.querySelectorAll('input[name="target"]:checked').forEach(input => { input.checked = false; }); }
  catch (error) { show(error.message, true); }
});
