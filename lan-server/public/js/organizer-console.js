const q = (selector) => document.querySelector(selector);
const mutationSelector = '[data-mutation] button, [data-mutation] input, [data-mutation] select, [data-mutation] textarea, button[data-mutation]';
let authorized = false;
let operational = false;
let api;
let getOrganizerToken;
let state = null;
let photoOperational = false;
let photoModeration = { settings: { enabled: false }, pending: [], published: [], removed: [] };
let photoPreviewUrls = [];

function lockPhotoControls() {
  document.querySelectorAll('#photo-moderation button, #photo-moderation input').forEach(control => {
    control.disabled = !(authorized && operational && photoOperational);
  });
}

export function lockMutations(reason = '') {
  document.querySelectorAll(mutationSelector).forEach(control => { control.disabled = !(authorized && operational); });
  lockPhotoControls();
  if (reason) q('#auth-status').textContent = reason;
}

function text(value) { return String(value ?? '—'); }
function escapeHtml(value) { const node = document.createElement('span'); node.textContent = text(value); return node.innerHTML; }
function status(message, error = false) { q('#operation-status').textContent = message; q('#operation-status').className = error ? 'warning' : 'notice'; }
function teamName(id) { return state.teams.find(team => team.id === id)?.name ?? id ?? 'Unassigned'; }
function eventName(id) { return state.events.find(event => event.id === id)?.name ?? id; }
function personName(id) { return state.participants.find(person => person.id === id)?.displayName ?? id; }
function mutationBody(reason, extra = {}) { return { confirm: true, reason, idempotencyKey: crypto.randomUUID(), ...extra }; }
function confirmReason(message) {
  if (!confirm(`Final confirmation\n\n${message}\n\nA verified pre-change backup and organizer-attributed audit entry will be created.`)) return null;
  const reason = prompt('Required reason for the audit trail:')?.trim();
  if (!reason) { status('Action cancelled: an audit reason is required.', true); return null; }
  return reason;
}

function cannonTeams() { return state.teams.filter(team => team.eventId === 'cannon'); }
function teamMembers(teamId) {
  return state.teamMembers.filter(member => member.teamId === teamId && member.active).map(member => state.participants.find(person => person.id === member.participantId)?.displayName).filter(Boolean);
}
function addTargetRow({ name = '', points = '', jackpot = false } = {}) {
  const row = document.createElement('div');
  row.className = 'target-editor-row';
  row.innerHTML = `<label>Target name<input class="target-name" maxlength="256" required></label><label>Points<input class="target-points" type="number" min="0" step="1" inputmode="numeric" required></label><label class="target-jackpot-label"><input class="target-jackpot" type="checkbox"> Million-point/jackpot winner</label><button class="btn secondary remove-target" type="button">Remove target</button>`;
  row.querySelector('.target-name').value = name;
  row.querySelector('.target-points').value = points;
  row.querySelector('.target-jackpot').checked = jackpot;
  q('#cannon-target-rows').append(row);
}
function renderCannonSetup() {
  const entries = (state.eventEntries ?? []).filter(entry => entry.eventId === 'cannon');
  const teams = cannonTeams();
  const configured = state.cannonRuns.length > 0;
  q('#cannon-team-preview').innerHTML = teams.length
    ? renderTable(['Team', 'Members', 'Physical lane'], teams.map((team, index) => [team.name, teamMembers(team.id).join(' + '), index % 2 === 0 ? 'Lane 1' : 'Lane 2']))
    : `<p class="meta">${entries.length} active Cannon signup${entries.length === 1 ? '' : 's'} · teams not formed yet.</p>`;
  q('#cannon-lane-preview').innerHTML = teams.length ? `<p class="notice"><b>Lane rotation preview:</b> ${teams.length} teams alternate across Lane 1 and Lane 2. Team shot quotas stay separate.</p>` : '';
  q('#cannon-setup-status').textContent = configured
    ? 'Cannon is configured. Open the Cannon console to record practice and scored shots.'
    : teams.length
      ? 'Teams are ready. Enter the real field targets, then create the two-lane run.'
      : 'Form Cannon teams after participants finish signup.';
  q('#form-cannon-teams').disabled = configured || teams.length > 0 || !(authorized && operational);
  document.querySelectorAll('[data-setup-control]').forEach(control => { if (configured) control.disabled = true; });
}

function renderTable(headers, rows) {
  if (!rows.length) return '<p class="meta">No records.</p>';
  return `<table><thead><tr>${headers.map(x => `<th>${escapeHtml(x)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map((x, index) => `<td data-label="${escapeHtml(headers[index])}">${escapeHtml(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

const photoActions = {
  pending: [['publish', 'Publish'], ['reject', 'Reject'], ['delete', 'Delete'], ['ban-uploader', 'Ban uploader']],
  published: [['remove', 'Remove'], ['delete', 'Delete'], ['ban-uploader', 'Ban uploader']],
  removed: [['restore', 'Restore'], ['delete', 'Delete'], ['ban-uploader', 'Ban uploader']],
};

function renderPhotoCard(photo, list) {
  const details = [photo.uploaderDisplayName, photo.names, photo.consentTimestamp, ...(photo.reasonCodes ?? [])].filter(Boolean).map(escapeHtml).join(' · ');
  const preview = photo.previewObjectUrl ? `<img src="${escapeHtml(photo.previewObjectUrl)}" alt="Organizer preview for photo ${escapeHtml(photo.id)}">` : '<div class="warning">Preview unavailable.</div>';
  const controls = photoActions[list].map(([action, label]) => `<button type="button" class="btn small ${action === 'delete' ? 'danger' : ''} photo-action" data-mutation data-photo="${escapeHtml(photo.id)}" data-photo-action="${action}">${label}</button>`).join('');
  return `<article class="photo-moderation-card">${preview}<b>${escapeHtml(photo.title ?? photo.state ?? 'Photo')}</b><p class="meta">${details || 'No optional names or review details.'}</p><div class="btn-row">${controls}</div></article>`;
}

function renderPhotoModeration() {
  q('#photo-wall-enabled').checked = photoModeration.settings?.enabled === true;
  for (const list of ['pending', 'published', 'removed']) {
    const photos = photoModeration[list] ?? [];
    q(`#photos-${list}`).innerHTML = photos.length ? photos.map(photo => renderPhotoCard(photo, list)).join('') : '<p class="meta">No records.</p>';
  }
  q('#photo-moderation-status').textContent = photoOperational
    ? `Junkyard Constellation ${photoModeration.settings?.enabled ? 'live' : 'stopped'} · ${(photoModeration.pending ?? []).length} awaiting approval.`
    : 'Junkyard Constellation moderation is unavailable or authorization is missing. Controls remain locked.';
  lockPhotoControls();
}

async function refreshPhotos() {
  photoPreviewUrls.forEach(url => URL.revokeObjectURL(url));
  photoPreviewUrls = [];
  if (!authorized || api.demo) { photoOperational = false; renderPhotoModeration(); return; }
  try {
    photoModeration = await api.getPhotoModeration();
    const all = ['pending', 'published', 'removed'].flatMap(list => photoModeration[list] ?? []);
    await Promise.all(all.map(async photo => {
      try {
        const url = URL.createObjectURL(await api.getOrganizerPhotoPreview(photo.id));
        photo.previewObjectUrl = url;
        photoPreviewUrls.push(url);
      } catch { photo.previewObjectUrl = ''; }
    }));
    photoOperational = true;
  } catch {
    photoOperational = false;
    photoModeration = { settings: { enabled: false }, pending: [], published: [], removed: [] };
  }
  renderPhotoModeration();
}

function render() {
  q('#participant-count').textContent = state.participants.length;
  q('#active-count').textContent = `${state.participants.filter(person => person.active).length} active`;
  q('#event-count').textContent = state.events.length;
  q('#match-count').textContent = state.matches.length;
  q('#dispute-count').textContent = state.disputes.length;
  const search = q('#participant-search').value.trim().toLowerCase();
  const people = state.participants.filter(person => !search || person.displayName.toLowerCase().includes(search) || person.id.toLowerCase().includes(search));
  q('#participants').innerHTML = people.length ? people.map(person => {
    const eventIds = state.eventEntries.filter(entry => entry.participantId === person.id).map(entry => entry.eventId);
    return `<article class="notice control-record"><b>${escapeHtml(person.displayName)}</b><small class="stable-id">${escapeHtml(person.id)}</small><p class="meta">Created ${escapeHtml(person.createdAt ? new Date(person.createdAt).toLocaleString() : 'unknown')} · ${person.active ? 'active' : 'inactive'} · ${escapeHtml(eventIds.map(eventName).join(', ') || 'no activities')}</p><div class="btn-row"><button class="btn small secondary edit-participant" type="button" data-mutation data-participant-id="${escapeHtml(person.id)}">Edit name / activities</button><button class="btn small ${person.active ? 'destructive' : 'secondary'} toggle-participant" type="button" data-mutation data-participant-id="${escapeHtml(person.id)}" data-active="${person.active ? 'false' : 'true'}">${person.active ? 'Deactivate' : 'Activate'}</button></div></article>`;
  }).join('') : '<p class="meta">No matching participants.</p>';
  q('#events').innerHTML = state.events.map(item => `<article class="notice control-record"><b>${escapeHtml(item.name)}</b><small class="stable-id">${escapeHtml(item.id)}</small><p class="meta">${escapeHtml(item.kind)} · ${item.available ? 'available' : 'unavailable'}</p><button class="btn small ${item.available ? 'destructive' : 'secondary'} event-availability" data-mutation data-event-id="${escapeHtml(item.id)}" data-available="${item.available ? 'false' : 'true'}">${item.available ? 'Close activity' : 'Open activity'}</button></article>`).join('');
  const visibleMatches = state.matches.filter(match => teamName(match.teamAId) !== 'BYE' && teamName(match.teamBId) !== 'BYE');
  const futureSlots = state.matches.length - visibleMatches.length;
  q('#matches').innerHTML = visibleMatches.map(match => `<article class="notice control-record"><b>${escapeHtml(eventName(match.eventId))}: ${escapeHtml(teamName(match.teamAId))} vs ${escapeHtml(teamName(match.teamBId))}</b><small class="stable-id">${escapeHtml(match.id)}</small><p class="meta">${escapeHtml(match.status)} · ${escapeHtml(state.stations.find(station => station.id === match.stationId)?.name ?? 'no station')}</p><div class="btn-row"><button class="btn small secondary match-action" data-mutation data-action="requeue" data-match-id="${escapeHtml(match.id)}">Requeue</button><button class="btn small secondary match-action" data-mutation data-action="assign-station" data-match-id="${escapeHtml(match.id)}">Assign station</button><button class="btn small secondary match-action" data-mutation data-action="correct-result" data-match-id="${escapeHtml(match.id)}">Correct result</button></div></article>`).join('') + (futureSlots ? `<p class="meta">${futureSlots} future bracket slot${futureSlots === 1 ? '' : 's'} hidden until prior-round winners advance.</p>` : '');
  q('#station-select').innerHTML = state.stations.filter(station => station.available).map(station => `<option value="${escapeHtml(station.id)}">${escapeHtml(station.name)} — ${escapeHtml(eventName(station.eventId))}</option>`).join('');
  q('#station-board').innerHTML = renderTable(['Station', 'Current match'], state.stations.map(station => {
    const match = state.matches.find(item => item.stationId === station.id && ['CALLED','ACTIVE','AWAITING_CONFIRMATION','DISPUTED'].includes(item.status));
    return [`${station.name} — ${eventName(station.eventId)}`, match ? `${teamName(match.teamAId)} vs ${teamName(match.teamBId)} · ${match.status}` : 'idle'];
  }));
  const filter = q('#team-event-filter').value;
  q('#team-event-filter').innerHTML = `<option value="">All activities</option>${state.events.filter(event => event.playMode !== 'CASUAL').map(event => `<option value="${escapeHtml(event.id)}" ${filter === event.id ? 'selected' : ''}>${escapeHtml(event.name)}</option>`).join('')}`;
  q('#bracket-event').innerHTML = state.events.filter(event => event.kind === 'HEAD_TO_HEAD' && event.playMode !== 'CASUAL').map(event => `<option value="${escapeHtml(event.id)}">${escapeHtml(event.name)}</option>`).join('');
  q('#teams').innerHTML = state.teams.filter(item => item.name !== 'BYE' && (!filter || item.eventId === filter)).map(item => {
    const active = state.teamMembers.filter(member => member.teamId === item.id && member.active);
    const original = state.teamMembers.filter(member => member.teamId === item.id && !member.substitute);
    return `<article class="notice control-record"><b>${escapeHtml(item.name)} — ${escapeHtml(eventName(item.eventId))}</b><small class="stable-id">${escapeHtml(item.id)}</small><p class="meta">Active: ${escapeHtml(active.map(member => personName(member.participantId)).join(' + ') || 'none')}<br>Original: ${escapeHtml(original.map(member => personName(member.participantId)).join(' + ') || 'none')}</p><div class="btn-row"><button class="btn small secondary team-action" data-mutation data-action="rename" data-team-id="${escapeHtml(item.id)}">Rename</button><button class="btn small secondary team-action" data-mutation data-action="ADD" data-team-id="${escapeHtml(item.id)}">Add</button><button class="btn small secondary team-action" data-mutation data-action="REMOVE" data-team-id="${escapeHtml(item.id)}">Remove</button><button class="btn small secondary team-action" data-mutation data-action="MOVE" data-team-id="${escapeHtml(item.id)}">Move</button><button class="btn small secondary team-action" data-mutation data-action="SWAP" data-team-id="${escapeHtml(item.id)}">Swap</button><button class="btn small secondary team-action" data-mutation data-action="SUBSTITUTE" data-team-id="${escapeHtml(item.id)}">Substitute</button></div></article>`;
  }).join('') || '<p class="meta">No teams for this activity.</p>';
  q('#station-controls').innerHTML = state.stations.map(station => `<article class="notice control-record"><b>${escapeHtml(station.name)} — ${escapeHtml(eventName(station.eventId))}</b><small class="stable-id">${escapeHtml(station.id)}</small><div class="btn-row"><button class="btn small ${station.available ? 'destructive' : 'secondary'} station-availability" data-mutation data-station-id="${escapeHtml(station.id)}" data-available="${station.available ? 'false' : 'true'}">${station.available ? 'Close station' : 'Open station'}</button><button class="btn small secondary station-event" data-mutation data-station-id="${escapeHtml(station.id)}">Swap mapped game</button></div></article>`).join('');
  q('#disputes').innerHTML = state.disputes.length ? state.disputes.map(dispute => {
    const match = state.matches.find(item => item.id === dispute.matchId);
    if (!match) return `<p class="warning">Dispute ${escapeHtml(dispute.id)} references missing match ${escapeHtml(dispute.matchId)}.</p>`;
    return `<article class="notice"><b>${escapeHtml(eventName(match.eventId))}: ${escapeHtml(teamName(match.teamAId))} vs ${escapeHtml(teamName(match.teamBId))}</b><p>Choose the official winner:</p><div class="btn-row"><button type="button" class="btn small resolve-dispute" data-mutation data-dispute="${escapeHtml(dispute.id)}" data-winner="${escapeHtml(match.teamAId)}">${escapeHtml(teamName(match.teamAId))}</button><button type="button" class="btn small resolve-dispute" data-mutation data-dispute="${escapeHtml(dispute.id)}" data-winner="${escapeHtml(match.teamBId)}">${escapeHtml(teamName(match.teamBId))}</button></div></article>`;
  }).join('') : '<p class="meta">No unresolved disputes.</p>';
  lockMutations();
  renderCannonSetup();
}

async function refresh() {
  state = await api.getState();
  render();
}

async function download(path, filename) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { Authorization: `Bearer ${getOrganizerToken()}` } });
  if (!response.ok) throw new Error((await response.text()) || `Export failed (${response.status})`);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}

lockMutations('Organizer authorization required; all mutation controls are locked.');
try {
  const authModule = await import('./auth.js');
  getOrganizerToken = authModule.getOrganizerToken;
  ({ api } = await import('./api.js'));
  authorized = Boolean(getOrganizerToken());
  if (api.demo) {
    q('#auth-status').textContent = 'Demo mode is inert. All mutations and authenticated downloads are disabled.';
  } else if (authorized) {
    operational = true;
    q('#auth-status').textContent = 'Organizer credential loaded for this tab.';
  }
  lockMutations();
  await refresh();
  await refreshPhotos();
  status('Authoritative state loaded from /api/state.');
} catch (error) {
  operational = false;
  lockMutations(`Console locked: ${error.message || 'credential/storage/state error'}`);
  status('Could not load authoritative server state. No mutations are available.', true);
}

q('#call-next-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!(authorized && operational) || api.demo) return;
  try { const result = await api.organizerRequest(`/api/stations/${encodeURIComponent(q('#station-select').value)}/call-next`, { method: 'POST', body: {} }); status(result.match ? `Called match ${result.match.id}.` : 'No eligible match is currently available.'); await refresh(); } catch (error) { status(error.message, true); }
});
q('#disputes').addEventListener('click', async event => {
  const button = event.target.closest('.resolve-dispute'); if (!button || !(authorized && operational) || api.demo) return;
  try { await api.organizerRequest(`/api/disputes/${encodeURIComponent(button.dataset.dispute)}/resolve`, { method: 'POST', body: { winningTeamId: button.dataset.winner } }); status('Dispute resolved and match finalized.'); await refresh(); } catch (error) { status(error.message, true); }
});
q('#participants').addEventListener('click', async event => {
  const button = event.target.closest('.toggle-participant, .edit-participant');
  if (!button || !(authorized && operational) || api.demo) return;
  const person = state.participants.find(item => item.id === button.dataset.participantId);
  if (!person) return status('Participant record no longer exists. Refresh and try again.', true);
  const added = person.createdAt ? new Date(person.createdAt).toLocaleString() : 'unknown time';
  const editing = button.classList.contains('edit-participant');
  const nextActive = editing ? Boolean(person.active) : button.dataset.active === 'true';
  const nextName = editing ? prompt(`Display name for stable id ${person.id}:`, person.displayName)?.trim() : person.displayName;
  if (!nextName) return;
  const currentEvents = state.eventEntries.filter(entry => entry.participantId === person.id).map(entry => entry.eventId);
  const eventIds = editing ? (prompt('Comma-separated activity ids:', currentEvents.join(', ')) ?? '').split(',').map(value => value.trim()).filter(Boolean) : currentEvents;
  const reason = confirmReason(`${editing ? 'Edit' : nextActive ? 'Activate' : 'Deactivate'} only ${person.displayName} (${person.id})?\nCreated: ${added}\ndisplayName: ${nextName}\neventIds: ${eventIds.join(', ')}\nactive: ${nextActive}\nHistory is retained.`);
  if (!reason) return;
  button.disabled = true;
  try {
    const result = await api.organizerRequest(`/api/organizer/participants/${encodeURIComponent(person.id)}`, { method: 'PATCH', body: mutationBody(reason, { displayName: nextName, active: nextActive, eventIds }) });
    status(`Updated ${person.displayName}. Backup ${result.backupId} created; history retained.`);
    await refresh();
  } catch (error) { status(error.message, true); button.disabled = false; }
});
q('#participant-search').addEventListener('input', render);
q('#team-event-filter').addEventListener('change', render);
q('#teams').addEventListener('click', async event => {
  const button = event.target.closest('.team-action'); if (!button || !(authorized && operational) || api.demo) return;
  const selected = state.teams.find(team => team.id === button.dataset.teamId); if (!selected) return;
  const action = button.dataset.action;
  let endpoint = `/api/organizer/teams/${encodeURIComponent(selected.id)}/lineup`, payload;
  if (action === 'rename') {
    const name = prompt('New team name:', selected.name)?.trim(); if (!name) return;
    endpoint = `/api/organizer/teams/${encodeURIComponent(selected.id)}/rename`; payload = { name };
  } else if (action === 'SUBSTITUTE') {
    const leavingParticipantId = prompt('Stable id of leaving participant:')?.trim(), replacementParticipantId = prompt('Stable id of substitute:')?.trim(); if (!leavingParticipantId || !replacementParticipantId) return;
    endpoint = `/api/organizer/teams/${encodeURIComponent(selected.id)}/substitute`; payload = { leavingParticipantId, replacementParticipantId };
  } else {
    const participantId = prompt('Stable id of participant:')?.trim(); if (!participantId) return;
    const extra = action === 'MOVE' ? { toTeamId: prompt('Destination team stable id:')?.trim() } : action === 'SWAP' ? { otherParticipantId: prompt('Other participant stable id:')?.trim() } : {};
    if (Object.values(extra).some(value => !value)) return;
    payload = { operation: action, participantId, ...extra };
  }
  const exact = Object.entries(payload).map(([key, value]) => `${key}: ${value}`).join('\n');
  const reason = confirmReason(`${action === 'rename' ? 'Rename' : action.toLowerCase()} ${selected.name} (${selected.id}) with:\n${exact}`); if (!reason) return;
  try { await api.organizerRequest(endpoint, { method: 'POST', body: mutationBody(reason, payload) }); status(`${action} completed for ${selected.name}.`); await refresh(); }
  catch (error) { status(error.message, true); }
});
q('#matches').addEventListener('click', async event => {
  const button = event.target.closest('.match-action'); if (!button || !(authorized && operational) || api.demo) return;
  const match = state.matches.find(item => item.id === button.dataset.matchId); if (!match) return;
  const action = button.dataset.action;
  const extra = action === 'assign-station' ? { stationId: prompt('Event-bound station stable id:')?.trim() } : action === 'correct-result' ? { winningTeamId: prompt(`Winning team stable id (${match.teamAId} or ${match.teamBId}):`)?.trim() } : {};
  if (Object.values(extra).some(value => !value)) return;
  const exact = Object.entries(extra).map(([key, value]) => `${key}: ${value}`).join('\n');
  const reason = confirmReason(`${action.replace('-', ' ')} match ${match.id}: ${teamName(match.teamAId)} vs ${teamName(match.teamBId)}${exact ? `\n${exact}` : ''}`); if (!reason) return;
  try { await api.organizerRequest(`/api/organizer/matches/${encodeURIComponent(match.id)}/${action}`, { method: 'POST', body: mutationBody(reason, extra) }); status(`Match ${action} completed.`); await refresh(); } catch (error) { status(error.message, true); }
});
q('#station-controls').addEventListener('click', async event => {
  const button = event.target.closest('.station-availability, .station-event'); if (!button || !(authorized && operational) || api.demo) return;
  const station = state.stations.find(item => item.id === button.dataset.stationId); if (!station) return;
  const changingEvent = button.classList.contains('station-event');
  const eventId = changingEvent ? prompt('Official scored game id to swap onto this station:', station.eventId)?.trim() : null;
  if (changingEvent && !eventId) return;
  const available = button.dataset.available === 'true';
  const message = changingEvent ? `Swap ${station.name} (${station.id}) from ${eventName(station.eventId)} to ${eventName(eventId)} (${eventId})?` : `${available ? 'Open' : 'Close'} ${station.name} (${station.id})?`;
  const reason = confirmReason(message); if (!reason) return;
  const endpoint = `/api/organizer/stations/${encodeURIComponent(station.id)}${changingEvent ? '/event' : ''}`;
  const body = changingEvent ? { eventId } : { available };
  try { await api.organizerRequest(endpoint, { method: 'PATCH', body: mutationBody(reason, body) }); status(`${station.name} updated.`); await refresh(); } catch (error) { status(error.message, true); }
});
q('#events').addEventListener('click', async event => {
  const button = event.target.closest('.event-availability'); if (!button || !(authorized && operational) || api.demo) return;
  const selected = state.events.find(item => item.id === button.dataset.eventId), available = button.dataset.available === 'true'; if (!selected) return;
  const reason = confirmReason(`${available ? 'Open' : 'Close'} ${selected.name} (${selected.id})?`); if (!reason) return;
  try { await api.organizerRequest(`/api/organizer/events/${encodeURIComponent(selected.id)}/availability`, { method: 'PATCH', body: mutationBody(reason, { available }) }); status(`${selected.name} updated.`); await refresh(); } catch (error) { status(error.message, true); }
});
q('#bracket-control-form').addEventListener('submit', async event => {
  event.preventDefault(); const eventId = q('#bracket-event').value, reason = confirmReason(`Regenerate the entire unplayed ${eventName(eventId)} bracket?`); if (!reason) return;
  try { await api.organizerRequest(`/api/organizer/events/${encodeURIComponent(eventId)}/bracket/regenerate`, { method: 'POST', body: mutationBody(reason) }); status(`${eventName(eventId)} bracket regenerated.`); await refresh(); } catch (error) { status(error.message, true); }
});
q('#backup').addEventListener('click', async () => { if (!(authorized && operational) || api.demo) return; try { const result = await api.organizerRequest('/api/admin/backups', { method: 'POST', body: {} }); status(`Backup created: ${result.backup.id}`); } catch (error) { status(error.message, true); } });
q('#export-json').addEventListener('click', () => authorized && operational && !api.demo && download('/api/admin/export.json', 'junkyard-export.json').then(() => status('JSON export downloaded.')).catch(error => status(error.message, true)));
q('#export-csv').addEventListener('click', () => authorized && operational && !api.demo && download('/api/admin/export.csv', 'junkyard-participants.csv').then(() => status('CSV export downloaded.')).catch(error => status(error.message, true)));
q('#add-cannon-target').addEventListener('click', () => addTargetRow());
q('#cannon-target-rows').addEventListener('click', event => {
  const button = event.target.closest('.remove-target');
  if (!button) return;
  if (q('#cannon-target-rows').children.length === 1) return status('At least one target is required.', true);
  button.closest('.target-editor-row').remove();
});
q('#cannon-target-rows').addEventListener('change', event => {
  if (!event.target.matches('.target-jackpot') || !event.target.checked) return;
  document.querySelectorAll('.target-jackpot').forEach(box => { if (box !== event.target) box.checked = false; });
});
q('#form-cannon-teams').addEventListener('click', async () => {
  if (!(authorized && operational) || api.demo) return;
  try {
    await api.organizerRequest('/api/admin/backups', { method: 'POST', body: {} });
    const result = await api.organizerRequest('/api/events/cannon/teams/form', { method: 'POST', body: {} });
    status(`Formed ${result.teams.length} Cannon teams. Review the pairs before creating the run.`);
    await refresh();
  } catch (error) { status(error.message, true); }
});
q('#cannon-setup-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!(authorized && operational) || api.demo) return;
  const targets = [...document.querySelectorAll('.target-editor-row')].map(row => ({
    name: row.querySelector('.target-name').value.trim(),
    points: Number(row.querySelector('.target-points').value),
    jackpot: row.querySelector('.target-jackpot').checked,
  }));
  if (!targets.length || targets.some(target => !target.name || !Number.isSafeInteger(target.points) || target.points < 0)) return status('Every target needs a name and whole-number point value.', true);
  const teams = cannonTeams();
  if (!teams.length) return status('Form Cannon teams before creating the run.', true);
  if (!confirm(`Create the Cannon run with ${teams.length} teams, ${targets.length} targets, and alternating Lane 1 / Lane 2 assignments?`)) return;
  const button = q('#create-cannon-run'); button.disabled = true; button.textContent = 'Backing up and creating run…';
  try {
    await api.organizerRequest('/api/admin/backups', { method: 'POST', body: {} });
    await api.organizerRequest('/api/cannon/setup', { method: 'POST', body: { confirm: true, targets } });
    await refresh();
    status('Cannon run created. Opening the live scoring ledger.');
    location.href = '/cannon.html';
  } catch (error) { status(error.message, true); button.disabled = false; button.textContent = 'Back up and create Cannon run'; }
});

if (!q('#cannon-target-rows').children.length) addTargetRow();
q('#photo-wall-enabled').addEventListener('change', async event => {
  if (!(authorized && operational && photoOperational) || api.demo) return;
  const enabled = event.target.checked;
  if (!enabled && !confirm('Stop Junkyard Constellation immediately? Approved photos will be hidden, not deleted.')) { event.target.checked = true; return; }
  try { await api.setPhotoWallEnabled(enabled); status(`Junkyard Constellation ${enabled ? 'live' : 'stopped'}.`); await refreshPhotos(); }
  catch (error) { event.target.checked = !enabled; status(error.message, true); }
});
q('#photo-moderation').addEventListener('click', async event => {
  const button = event.target.closest('.photo-action');
  if (!button || !(authorized && operational && photoOperational) || api.demo) return;
  const action = button.dataset.photoAction;
  const destructive = ['reject', 'remove', 'delete', 'ban-uploader'].includes(action);
  if (destructive && !confirm(action === 'delete' ? 'Permanently delete this photo and its pixels?' : action === 'ban-uploader' ? 'Ban this uploader and block future uploads?' : action === 'reject' ? 'Reject this photo?' : 'Remove this photo from public display?')) return;
  try { await api.moderatePhoto(button.dataset.photo, action); status(`Photo action complete: ${action}.`); await refreshPhotos(); }
  catch (error) { status(error.message, true); }
});
window.addEventListener('pagehide', () => photoPreviewUrls.forEach(url => URL.revokeObjectURL(url)));
