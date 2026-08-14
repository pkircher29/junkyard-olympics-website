import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = resolve(ROOT, 'fixtures');
const RUN = `${Date.now()}-${process.pid}`;
const EXTERNAL_URL = process.env.JO_BASE_URL;
const APP_MODULE = process.env.JO_APP_MODULE;
const CHRIS = process.env.JO_ORGANIZER_CHRIS ?? 'acceptance-chris';
const PAUL = process.env.JO_ORGANIZER_PAUL ?? 'acceptance-paul';
const organizer = (credential = CHRIS) => ({ Authorization: `Bearer ${credential}` });

let baseUrl = EXTERNAL_URL ?? 'http://127.0.0.1:8790';
let server;
let importedFactory;
let targetFailure;
const world = { participants: [], events: new Map(), stations: [], teams: [], matches: [] };

async function fixture(name) {
  return JSON.parse(await readFile(resolve(FIXTURES, name), 'utf8'));
}

async function startImportedApp() {
  const modulePath = resolve(ROOT, APP_MODULE);
  const mod = await import(`${pathToFileURL(modulePath).href}?acceptance=${Date.now()}`);
  importedFactory = mod.createApp ?? (typeof mod.default === 'function' ? mod.default : undefined);
  const app = importedFactory ? await importedFactory({ acceptance: true }) : (mod.app ?? mod.default);
  assert.equal(typeof app?.listen, 'function', `${APP_MODULE} must export app/default.listen() or createApp()`);
  await new Promise((resolveStart, reject) => {
    server = app.listen(0, '127.0.0.1', resolveStart);
    server.once('error', reject);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopServer() {
  if (!server) return;
  await new Promise((resolveStop, reject) => server.close(error => error ? reject(error) : resolveStop()));
  server = undefined;
}

async function restartImportedApp() {
  assert.ok(APP_MODULE, 'ACC-026 process restart requires JO_APP_MODULE; use the built app factory for this test');
  await stopServer();
  await startImportedApp();
}

async function raw(path, { method = 'GET', headers = {}, body, timeout = 4_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(new URL(path, baseUrl), {
      method,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (error) {
    const detail = error?.cause?.code ?? error?.name ?? String(error);
    assert.fail(`acceptance target ${baseUrl} is unavailable (${detail}); start the MVP or set JO_BASE_URL/JO_APP_MODULE`);
  } finally {
    clearTimeout(timer);
  }
}

async function request(path, options = {}, expected = [200]) {
  const response = await raw(path, options);
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  assert.ok(expected.includes(response.status), `${options.method ?? 'GET'} ${path}: expected ${expected.join('/')} but got ${response.status}; body=${text.slice(0, 500)}`);
  return { response, data, text };
}

async function expectDenied(path, options = {}) {
  const { data, response } = await request(path, options, [400, 401, 403, 409, 422, 429]);
  assert.equal(typeof data?.error?.code, 'string', `${path} denial needs stable error.code`);
  return { data, response };
}

function bearer(token) { return { Authorization: `Bearer ${token}` }; }
function id(value, label = 'resource') {
  const found = value?.id ?? value;
  assert.ok(typeof found === 'string' && found.length > 0, `${label} must expose a non-empty string id`);
  return found;
}
function list(data, key) {
  const value = Array.isArray(data) ? data : data?.[key];
  assert.ok(Array.isArray(value), `response must expose ${key} array`);
  return value;
}
function unique(values, label) { assert.equal(new Set(values).size, values.length, `${label} must be unique`); }
function containsSecret(value, secrets) {
  const text = JSON.stringify(value);
  return secrets.some(secret => secret && text.includes(secret));
}
async function signup(displayName) {
  const { data } = await request('/api/participants', { method: 'POST', body: { displayName } }, [201]);
  const participant = data?.participant;
  id(participant, 'participant');
  assert.equal(participant.displayName, displayName);
  assert.ok(typeof data.token === 'string' && data.token.length >= 24, 'signup must return a private high-entropy bearer token');
  return { ...participant, token: data.token };
}
async function events() {
  const { data } = await request('/api/events');
  const values = list(data, 'events');
  for (const event of values) { id(event, 'event'); assert.equal(typeof event.name, 'string'); }
  return values;
}
function eventNamed(name) {
  const event = [...world.events.values()].find(candidate => candidate.name === name || candidate.kind === name);
  assert.ok(event, `seeded event '${name}' is required`);
  return event;
}
async function formTeams(eventId, participants) {
  const { data } = await request(`/api/events/${eventId}/teams/form`, {
    method: 'POST', headers: organizer(), body: { participantIds: participants.map(p => p.id) },
  }, [200, 201]);
  return list(data, 'teams');
}
function memberIds(team) { return team.participantIds ?? team.members?.map(member => member.id ?? member) ?? []; }
async function matchState(matchId) {
  const { data } = await request(`/api/matches/${matchId}`);
  return data.match ?? data;
}

async function callAndActivateMatch(eventId) {
  const stations = list((await request('/api/stations')).data, 'stations');
  const station = stations.find(item => (item.eventId ?? item.event_id) === eventId);
  assert.ok(station, `official event ${eventId} requires a mapped station`);
  const { data } = await request('/api/schedule/call-next', {
    method: 'POST', headers: organizer(), body: { stationId: station.id, now: new Date().toISOString() },
  }, [200, 201]);
  const match = data.match;
  assert.ok(match, `station ${station.id} must call an eligible match`);
  const teamIds = match.teamIds ?? [match.teamAId, match.teamBId].filter(Boolean);
  const teams = world.bracket.teams.filter(team => teamIds.includes(team.id));
  assert.equal(teams.length, 2, 'called match must expose two known teams');
  const first = world.participants.find(person => memberIds(teams[0]).includes(person.id));
  const second = world.participants.find(person => memberIds(teams[1]).includes(person.id));
  assert.ok(first?.token && second?.token, 'called teams require participant credentials');
  await request(`/api/matches/${match.id}/check-in`, { method: 'POST', headers: bearer(first.token), body: {} }, [200, 201]);
  await request(`/api/matches/${match.id}/check-in`, { method: 'POST', headers: bearer(second.token), body: {} }, [200, 201]);
  assert.equal((await matchState(match.id)).status, 'active');
  return { match, teams };
}

async function burstUntilLimited(label, makeRequest, allowedBeforeLimit, maximum = 80) {
  for (let index = 0; index < maximum; index++) {
    const response = await makeRequest(index);
    if (response.status === 429) {
      assert.ok(response.headers.get('retry-after'), `${label}: 429 must include Retry-After`);
      const data = await response.json().catch(() => null);
      assert.equal(typeof data?.error?.code, 'string', `${label}: 429 needs stable error.code`);
      return;
    }
    assert.ok(allowedBeforeLimit.includes(response.status), `${label}: unexpected pre-limit status ${response.status}`);
  }
  assert.fail(`${label}: ${maximum}-request burst never reached rate limit`);
}

before(async () => {
  try {
    if (APP_MODULE) await startImportedApp();
    const response = await raw('/api/health');
    if (response.status !== 200) targetFailure = `GET /api/health returned ${response.status}`;
    else {
      const data = await response.json().catch(() => null);
      if (data?.ok !== true) targetFailure = 'GET /api/health did not return {ok:true}';
    }
  } catch (error) {
    targetFailure = error.message;
  }
});
after(stopServer);

function requireTarget() {
  assert.equal(targetFailure, undefined, targetFailure ?? 'target unavailable');
}

// Contract sanity tests prove fixture/harness validity and stay GREEN while product tests are RED.
test('HARNESS-001 fixtures describe exactly 30 adults including a duplicate public name', async () => {
  const { participants } = await fixture('participants.json');
  assert.equal(participants.length, 30);
  assert.equal(participants.filter(p => p.displayName === 'Alex Scrap').length, 2);
  unique(participants.map(p => p.key), 'fixture participant keys');
});

test('HARNESS-002 standings oracle encodes Cannon plus best-three and eligibility', async () => {
  const { cases } = await fixture('standings-cases.json');
  assert.deepEqual(cases.find(c => c.key === 'best-three-drops-weaker').expected, {
    total: 29, counted: [10, 7, 5], dropped: [3, 1], eligible: true,
  });
  assert.equal(cases.find(c => c.key === 'missing-cannon-ineligible').expected.eligible, false);
});

test('ACC-001 health contract is reachable and explicit', () => requireTarget());

test('ACC-002/003 register 30 adults; duplicate names retain isolated identities across refresh', async () => {
  requireTarget();
  const source = (await fixture('participants.json')).participants;
  world.participants = [];
  for (const person of source) world.participants.push(await signup(`${person.displayName} [${RUN}]`.replace(`Alex Scrap [${RUN}]`, 'Alex Scrap')));
  assert.equal(world.participants.length, 30);
  unique(world.participants.map(p => p.id), 'participant IDs');
  unique(world.participants.map(p => p.token), 'participant tokens');
  const duplicates = world.participants.filter(p => p.displayName === 'Alex Scrap');
  assert.equal(duplicates.length, 2);
  for (const participant of duplicates) {
    const { data } = await request('/api/me', { headers: bearer(participant.token) });
    assert.equal((data.participant ?? data).id, participant.id);
    assert.equal(containsSecret(data, world.participants.map(p => p.token)), false, '/api/me must not echo bearer secrets');
  }
});

test('ACC-004 participant authorization is isolated and public payloads leak no bearer tokens', async () => {
  requireTarget();
  assert.ok(world.participants.length >= 2, 'ACC-002 must complete first');
  const [alice, bob] = world.participants;
  await expectDenied(`/api/participants/${alice.id}`, { method: 'PATCH', headers: bearer(bob.token), body: { displayName: 'STOLEN' } });
  await expectDenied('/api/events/not-an-event/participants/me', { method: 'PUT', body: {} });
  const { data } = await request('/api/participants');
  assert.equal(containsSecret(data, world.participants.map(p => p.token)), false, 'public roster leaked a bearer token');
});

test('ACC-005 event pool join/leave is authorized, dynamic, and idempotent', async () => {
  requireTarget();
  const catalog = await events();
  world.events = new Map(catalog.map(event => [event.id, event]));
  const participant = world.participants[0];
  const event = catalog.find(e => e.kind === 'head-to-head') ?? catalog[1];
  const path = `/api/events/${event.id}/participants/me`;
  await request(path, { method: 'PUT', headers: bearer(participant.token), body: {} }, [200, 201]);
  await request(path, { method: 'PUT', headers: bearer(participant.token), body: {} }, [200]);
  await request(path, { method: 'DELETE', headers: bearer(participant.token) }, [200, 204]);
  await request(path, { method: 'DELETE', headers: bearer(participant.token) }, [200, 204]);
  const { data } = await request(`/api/events/${event.id}`);
  const ids = (data.event ?? data).participantIds ?? [];
  assert.equal(ids.includes(participant.id), false);
});

test('ACC-006/007 pair formation covers even pools, makes one odd trio, and avoids available repeats', async () => {
  requireTarget();
  const event = eventNamed('head-to-head');
  const even = await formTeams(event.id, world.participants);
  assert.equal(even.length, 15);
  assert.ok(even.every(team => memberIds(team).length === 2));
  assert.deepEqual(new Set(even.flatMap(memberIds)), new Set(world.participants.map(p => p.id)));
  const oddPeople = world.participants.slice(0, 15);
  const odd = await formTeams(event.id, oddPeople);
  assert.equal(odd.filter(team => memberIds(team).length === 3).length, 1);
  assert.equal(odd.filter(team => memberIds(team).length === 2).length, 6);
  assert.deepEqual(new Set(odd.flatMap(memberIds)), new Set(oddPeople.map(p => p.id)));
  const oldPartners = new Set(even.flatMap(team => memberIds(team).flatMap((p, i, all) => all.slice(i + 1).map(q => [p, q].sort().join(':')))));
  const repeated = odd.flatMap(team => memberIds(team).flatMap((p, i, all) => all.slice(i + 1).map(q => [p, q].sort().join(':')))).filter(pair => oldPartners.has(pair));
  assert.equal(repeated.length, 0, 'pairer repeated partners despite a 15-person alternative pool');
});

test('ACC-008/009 Cannon uses two lanes and stores exactly 20 scored plus 10 practice shots per team idempotently', async () => {
  requireTarget();
  const cannon = eventNamed('Junkyard Cannon');
  const teams = await formTeams(cannon.id, world.participants.slice(0, 4));
  const { data } = await request('/api/cannon/runs', {
    method: 'POST', headers: organizer(), body: { eventId: cannon.id, teamIds: teams.map(id), laneIds: ['lane-1', 'lane-2'] },
  }, [200, 201]);
  const run = data.run ?? data; id(run, 'Cannon run');
  assert.deepEqual(new Set((run.assignments ?? []).map(a => a.laneId)), new Set(['lane-1', 'lane-2']));
  for (const [teamIndex, team] of teams.entries()) {
    for (const kind of ['practice', 'scored']) {
      const count = kind === 'practice' ? 10 : 20;
      for (let sequence = 1; sequence <= count; sequence++) {
        const body = { teamId: team.id, laneId: `lane-${teamIndex + 1}`, kind, sequence, targetIds: [] };
        const path = `/api/cannon/runs/${run.id}/shots`;
        await request(path, { method: 'POST', headers: organizer(), body }, [200, 201]);
        if (kind === 'scored' && sequence === 1) await request(path, { method: 'POST', headers: organizer(), body }, [200, 201]);
      }
    }
  }
  const { data: audit } = await request(`/api/cannon/runs/${run.id}/shots`, { headers: organizer() });
  for (const team of teams) {
    const shots = list(audit, 'shots').filter(shot => shot.teamId === team.id);
    assert.equal(shots.filter(s => s.kind === 'practice').length, 10);
    assert.equal(shots.filter(s => s.kind === 'scored').length, 20);
  }
  world.cannon = { run, teams };
});

test('ACC-010/011 multi-target stacking and organizer-confirmed Carnage are auditable and exact', async () => {
  requireTarget();
  const catalog = await fixture('event-catalog.json');
  const targetPayload = { targets: catalog.targets.map(({ name, points, jackpot }) => ({ name, points, jackpot })) };
  const { data: targetData } = await request('/api/cannon/targets', { method: 'POST', headers: organizer(), body: targetPayload }, [200, 201]);
  const targets = list(targetData, 'targets');
  const ordinary = targets.filter(t => !t.jackpot).slice(0, 2);
  const cannon = eventNamed('Junkyard Cannon');
  const teams = await formTeams(cannon.id, world.participants.slice(4, 8));
  const { data: runData } = await request('/api/cannon/runs', {
    method: 'POST', headers: organizer(), body: { eventId: cannon.id, teamIds: teams.map(id), laneIds: ['lane-1', 'lane-2'] },
  }, [200, 201]);
  const run = runData.run ?? runData;
  const shotBody = { teamId: teams[0].id, laneId: 'lane-1', kind: 'scored', sequence: 1, targetIds: ordinary.map(t => t.id), carnage: true };
  await expectDenied(`/api/cannon/runs/${run.id}/shots`, { method: 'POST', headers: bearer(world.participants[4].token), body: shotBody });
  const { data } = await request(`/api/cannon/runs/${run.id}/shots`, { method: 'POST', headers: organizer(PAUL), body: shotBody }, [200, 201]);
  const shot = data.shot ?? data;
  assert.equal(shot.targetPoints, ordinary.reduce((sum, target) => sum + target.points, 0));
  assert.equal(shot.carnageBonus, 50);
  assert.equal(shot.total, shot.targetPoints + 50);
  assert.equal(shot.organizerConfirmed, true);
  const { data: flair } = await request('/api/standings/flair');
  for (const participantId of memberIds(teams[0])) {
    const row = list(flair, 'standings').find(item => item.participantId === participantId);
    assert.equal(row?.categories?.['Spectacular Destruction'], 1, 'Carnage must grant both teammates one destruction prop');
  }
  world.scoringCannon = { run, teams, targets };
});

test('ACC-012/013 jackpot guarantees Cannon first; sudden death persists equal rounds and breaks top-four ties', async () => {
  requireTarget();
  const { run, teams, targets } = world.scoringCannon;
  const jackpot = targets.find(t => t.jackpot);
  assert.ok(jackpot, 'configured jackpot target required');
  await request(`/api/cannon/runs/${run.id}/shots`, { method: 'POST', headers: organizer(), body: { teamId: teams[1].id, laneId: 'lane-2', kind: 'scored', sequence: 1, targetIds: [jackpot.id] } }, [200, 201]);
  const standings = list((await request(`/api/cannon/runs/${run.id}/standings`)).data, 'standings');
  assert.equal(standings[0].teamId, teams[1].id);
  assert.equal(standings[0].jackpot, true);

  const cannon = eventNamed('Junkyard Cannon');
  const tieTeams = await formTeams(cannon.id, world.participants.slice(8, 12));
  const { data: tieRunData } = await request('/api/cannon/runs', {
    method: 'POST', headers: organizer(), body: { eventId: cannon.id, teamIds: tieTeams.map(id), laneIds: ['lane-1', 'lane-2'] },
  }, [200, 201]);
  const tieRun = tieRunData.run ?? tieRunData;
  const ordinary = targets.find(target => !target.jackpot);
  for (const [index, team] of tieTeams.entries()) await request(`/api/cannon/runs/${tieRun.id}/shots`, {
    method: 'POST', headers: organizer(), body: { teamId: team.id, laneId: `lane-${index + 1}`, kind: 'scored', sequence: 1, targetIds: [ordinary.id] },
  }, [200, 201]);
  let tie = (await request(`/api/cannon/runs/${tieRun.id}/standings`)).data.tie;
  assert.ok(tie?.unresolved, 'ordinary top-four tie must require sudden death');
  const tiedTeamIds = tieTeams.map(t => t.id);
  for (const teamId of tiedTeamIds) await request(`/api/cannon/runs/${tieRun.id}/shootout-shots`, { method: 'POST', headers: organizer(), body: { teamId, round: 1, targetIds: [] } }, [200, 201]);
  tie = (await request(`/api/cannon/runs/${tieRun.id}/standings`)).data.tie;
  assert.ok(tie?.unresolved, 'equal shootout round must not break tie');
  await request(`/api/cannon/runs/${tieRun.id}/shootout-shots`, { method: 'POST', headers: organizer(), body: { teamId: tiedTeamIds[0], round: 2, points: 10 } }, [200, 201]);
  await request(`/api/cannon/runs/${tieRun.id}/shootout-shots`, { method: 'POST', headers: organizer(), body: { teamId: tiedTeamIds[1], round: 2, points: 0 } }, [200, 201]);
  tie = (await request(`/api/cannon/runs/${tieRun.id}/standings`)).data.tie;
  assert.equal(tie?.unresolved, false);
});

test('ACC-014 eight-team bracket provides consolation without displacing main top four', async () => {
  requireTarget();
  const event = eventNamed('head-to-head');
  const teams = await formTeams(event.id, world.participants.slice(0, 16));
  const { data } = await request(`/api/events/${event.id}/bracket`, { method: 'POST', headers: organizer(), body: { teamIds: teams.map(id) } }, [200, 201]);
  const bracket = data.bracket ?? data;
  assert.equal(list(bracket, 'mainMatches').filter(m => m.round === 1).length, 4);
  assert.equal(list(bracket, 'consolationMatches').length >= 1, true);
  assert.equal(bracket.consolationAffectsTopFour ?? false, false);
  world.bracket = { event, teams, bracket };
});

test('ACC-015 only one opposing participant may finalize a reported result atomically', async () => {
  requireTarget();
  const { match, teams } = await callAndActivateMatch(world.bracket.event.id);
  const reporting = world.participants.find(p => memberIds(teams[0]).includes(p.id));
  const teammate = world.participants.find(p => memberIds(teams[0]).includes(p.id) && p.id !== reporting.id);
  const opponent = world.participants.find(p => memberIds(teams[1]).includes(p.id));
  const key = `result-${RUN}`;
  await request(`/api/matches/${match.id}/result-reports`, { method: 'POST', headers: bearer(reporting.token), body: { winnerTeamId: teams[0].id, idempotencyKey: key } }, [200, 201]);
  await expectDenied(`/api/matches/${match.id}/result-confirmations`, { method: 'POST', headers: bearer(teammate.token), body: { agree: true, idempotencyKey: `same-${RUN}` } });
  const confirmationBody = { agree: true, idempotencyKey: `opp-${RUN}` };
  await request(`/api/matches/${match.id}/result-confirmations`, { method: 'POST', headers: bearer(opponent.token), body: confirmationBody }, [200, 201]);
  await request(`/api/matches/${match.id}/result-confirmations`, { method: 'POST', headers: bearer(opponent.token), body: confirmationBody }, [200, 201]);
  const state = await matchState(match.id);
  assert.equal(state.status, 'confirmed');
  assert.equal(state.winnerTeamId, teams[0].id);
  assert.equal(state.advancementCount ?? 1, 1);
  world.confirmedMatch = match;
  world.confirmation = { token: opponent.token, body: confirmationBody };
});

test('ACC-016 disagreement freezes match, records dispute, and does not advance bracket', async () => {
  requireTarget();
  const { match, teams } = await callAndActivateMatch(world.bracket.event.id);
  const reporter = world.participants.find(p => memberIds(teams[0]).includes(p.id));
  const opponent = world.participants.find(p => memberIds(teams[1]).includes(p.id));
  await request(`/api/matches/${match.id}/result-reports`, { method: 'POST', headers: bearer(reporter.token), body: { winnerTeamId: teams[0].id, idempotencyKey: `dispute-report-${RUN}` } }, [200, 201]);
  await request(`/api/matches/${match.id}/result-confirmations`, { method: 'POST', headers: bearer(opponent.token), body: { agree: false, idempotencyKey: `dispute-${RUN}` } }, [200, 201]);
  const state = await matchState(match.id);
  assert.equal(state.status, 'disputed');
  assert.ok(state.dispute?.id);
  assert.equal(state.advanced ?? false, false);
  await request(`/api/disputes/${state.dispute.id}/resolve`, {
    method: 'POST', headers: organizer(), body: { winningTeamId: teams[0].id },
  }, [200, 201]);
});

test('ACC-017 simultaneous station calls never double-book a participant', async () => {
  requireTarget();
  const { data: stationsData } = await request('/api/stations');
  const stations = list(stationsData, 'stations');
  assert.ok(stations.length >= 2, 'two simultaneous stations required');
  const secondEventId = stations[1].eventId ?? stations[1].event_id;
  const firstEventBracket = (await request(`/api/events/${world.bracket.event.id}/bracket`)).data.bracket;
  const pendingOpeningMatches = list(firstEventBracket, 'mainMatches').filter(match => match.status === 'pending' && match.participantIds?.length && match.round === 1);
  assert.ok(pendingOpeningMatches.length >= 1, 'first station requires a pending overlap candidate');
  for (const extra of pendingOpeningMatches.slice(1)) await request(`/api/matches/${extra.id}/forfeit`, {
    method: 'POST', headers: organizer(), body: { winningTeamId: extra.teamIds[0] },
  }, [200, 201]);
  const pendingFirstEventMatch = pendingOpeningMatches[0];
  const overlappingParticipant = world.participants.find(person => person.id === pendingFirstEventMatch.participantIds[0]);
  assert.ok(overlappingParticipant, 'overlap candidate must have a participant credential');
  const secondPool = [overlappingParticipant, ...world.participants.slice(16, 19)];
  const secondTeams = await formTeams(secondEventId, secondPool);
  await request(`/api/events/${secondEventId}/bracket`, {
    method: 'POST', headers: organizer(), body: { teamIds: secondTeams.map(id) },
  }, [200, 201]);
  const now = new Date().toISOString();
  const calls = await Promise.all(stations.slice(0, 2).map(station => request('/api/schedule/call-next', { method: 'POST', headers: organizer(), body: { stationId: station.id, now } }, [200, 201])));
  const matches = calls.map(call => call.data.match).filter(Boolean);
  const allPlayers = matches.flatMap(match => match.participantIds ?? []);
  assert.equal(matches.length, 1, 'one of two overlapping simultaneous calls must be suppressed');
  assert.ok(allPlayers.includes(overlappingParticipant.id), 'the exercised call must contain the shared participant');
  unique(allPlayers, 'players across simultaneous station calls');
  world.called = matches;
});

test('ACC-018/019 cooldown boundary and five-minute timeout skip rather than forfeit', async () => {
  requireTarget();
  const match = world.called[0]; assert.ok(match, 'scheduler must call a match');
  const completedAt = new Date('2026-08-15T19:00:00.000Z');
  await request(`/api/matches/${match.id}/complete`, { method: 'POST', headers: organizer(), body: { winnerTeamId: match.teamIds[0], completedAt: completedAt.toISOString() } }, [200, 201]);
  const before = await request('/api/schedule/call-next', { method: 'POST', headers: organizer(), body: { stationId: match.stationId, now: new Date(completedAt.getTime() + 299_000).toISOString(), participantIds: match.participantIds } }, [200, 201]);
  assert.equal(before.data.match ?? null, null, '4:59 cooldown call should be ineligible');
  const boundary = await request('/api/schedule/call-next', { method: 'POST', headers: organizer(), body: { stationId: match.stationId, now: new Date(completedAt.getTime() + 300_000).toISOString(), participantIds: match.participantIds } }, [200, 201]);
  assert.ok(boundary.data.match || boundary.data.eligible === true, 'player must be eligible at 5:00 boundary');
  const called = boundary.data.match;
  if (called) {
    await request('/api/schedule/tick', { method: 'POST', headers: organizer(), body: { now: new Date(new Date(called.calledAt).getTime() + 300_001).toISOString() } }, [200]);
    const state = await matchState(called.id);
    assert.equal(state.status, 'skipped');
    assert.notEqual(state.status, 'forfeited');
  }
});

test('ACC-020 pre-semifinal late entry preserves results; post-semifinal championship entry is rejected', async () => {
  requireTarget();
  const { event } = world.bracket;
  const early = await signup(`Early Entrant [${RUN}]`);
  const late = await signup(`Late Entrant [${RUN}]`);
  world.participants.push(early, late);
  await request(`/api/events/${event.id}/participants/me`, { method: 'PUT', headers: bearer(early.token), body: {} }, [200, 201]);
  await request(`/api/events/${event.id}/participants/me`, { method: 'PUT', headers: bearer(late.token), body: {} }, [200, 201]);
  await request(`/api/events/${event.id}/bracket/late-entries`, { method: 'POST', headers: organizer(), body: { participantId: early.id } }, [200, 201]);
  const before = (await request(`/api/events/${event.id}/bracket`)).data;
  const bracketBefore = before.bracket ?? before;
  const openingMatches = list(bracketBefore, 'mainMatches').filter(item => item.round === 1);
  for (const match of openingMatches.filter(item => !['confirmed', 'final'].includes(item.status))) {
    const winningTeamId = (match.teamIds ?? [match.teamAId, match.teamBId].filter(Boolean))[0];
    assert.ok(winningTeamId, `opening match ${match.id} requires a team before semifinal lock`);
    await request(`/api/matches/${match.id}/forfeit`, { method: 'POST', headers: organizer(), body: { winningTeamId } }, [200, 201]);
  }
  const playIn = list((await request(`/api/events/${event.id}/bracket`)).data.bracket, 'playInMatches').find(item => item.status === 'pending');
  assert.ok(playIn, 'bracket projection must expose the late-entry play-in before semifinals');
  const playInWinner = (playIn.teamIds ?? [playIn.teamAId, playIn.teamBId].filter(Boolean))[0];
  await request(`/api/matches/${playIn.id}/forfeit`, { method: 'POST', headers: organizer(), body: { winningTeamId: playInWinner } }, [200, 201]);
  await request(`/api/events/${event.id}/bracket/semifinals/start`, { method: 'POST', headers: organizer(), body: {} }, [200, 201]);
  await expectDenied(`/api/events/${event.id}/bracket/late-entries`, { method: 'POST', headers: organizer(), body: { participantId: late.id } });
  const after = (await request(`/api/events/${event.id}/bracket`)).data;
  const completed = value => list(value.bracket ?? value, 'mainMatches').filter(m => m.status === 'confirmed').map(m => [m.id, m.winnerTeamId]);
  const beforeCompleted = new Map(completed(before));
  const afterCompleted = new Map(completed(after));
  for (const [matchId, winnerTeamId] of beforeCompleted) assert.equal(afterCompleted.get(matchId), winnerTeamId, `late entry rewrote completed result ${matchId}`);
});

test('ACC-021 departure substitution is public/reversible and cannot award duplicate placement points', async () => {
  requireTarget();
  const stations = list((await request('/api/stations')).data, 'stations');
  const station = stations[2];
  assert.ok(station, 'substitution setup requires a third official station');
  const substitutionEventId = station.eventId ?? station.event_id;
  const substitutionTeams = await formTeams(substitutionEventId, world.participants.slice(22, 30));
  await request(`/api/events/${substitutionEventId}/bracket`, {
    method: 'POST', headers: organizer(), body: { teamIds: substitutionTeams.map(id) },
  }, [200, 201]);
  const match = (await request('/api/schedule/call-next', {
    method: 'POST', headers: organizer(), body: { stationId: station.id, now: new Date().toISOString() },
  }, [200, 201])).data.match;
  assert.ok(match, 'substitution setup requires a fresh called match');
  const participant = world.participants.find(person => match.participantIds.includes(person.id));
  assert.ok(participant?.token, 'called match requires a credentialed leaver');
  await request('/api/participants/me/departure', { method: 'POST', headers: bearer(participant.token), body: {} }, [200]);
  const { data } = await request(`/api/matches/${match.id}/substitutions/auto`, { method: 'POST', headers: organizer(), body: {} }, [200, 201]);
  const substitution = data.substitution ?? data;
  assert.ok(substitution.id && substitution.reversible === true && substitution.public === true);
  const substitutedMatch = await matchState(match.id);
  assert.ok(substitutedMatch.participantIds.includes(substitution.inParticipantId), 'replacement must be active on the selected match');
  assert.ok(!substitutedMatch.participantIds.includes(substitution.leavingParticipantId), 'departed participant must leave the selected match roster');
  const winningTeamId = (match.teamIds ?? [match.teamAId, match.teamBId].filter(Boolean))[0];
  await request(`/api/matches/${match.id}/forfeit`, { method: 'POST', headers: organizer(), body: { winningTeamId } }, [200, 201]);
  for (let pass = 0; pass < 12; pass++) {
    const bracket = (await request(`/api/events/${substitutionEventId}/bracket`)).data.bracket;
    const playable = list(bracket, 'mainMatches').find(candidate => candidate.status === 'pending' && candidate.teamIds?.length === 2 && candidate.teamIds.every(teamId => !teamId.startsWith('bye:')));
    if (!playable) break;
    await request(`/api/matches/${playable.id}/forfeit`, { method: 'POST', headers: organizer(), body: { winningTeamId: playable.teamIds[0] } }, [200, 201]);
  }
  const firstFinalization = await request(`/api/events/${substitutionEventId}/finalize`, { method: 'POST', headers: organizer(), body: {} }, [200]);
  const replayFinalization = await request(`/api/events/${substitutionEventId}/finalize`, { method: 'POST', headers: organizer(), body: {} }, [200]);
  assert.deepEqual(replayFinalization.data.placements, firstFinalization.data.placements, 'event finalization replay changed placements');
  const { data: standings } = await request(`/api/events/${substitutionEventId}/standings`);
  const substituteRows = list(standings, 'standings').filter(row => row.participantId === substitution.inParticipantId);
  assert.equal(substituteRows.length, 1, 'substitute must receive exactly one finalized placement row');
  const substituteRow = substituteRows[0];
  assert.equal(substituteRow.placementPointsAwardCount, 1, 'substitute must receive exactly one placement award');
  assert.equal(substituteRow.points, ({ 1: 10, 2: 7, 3: 5, 4: 3 })[substituteRow.place], 'substitute placement points must match place');
  const auditEntries = list((await request('/api/admin/audit', { headers: organizer() })).data, 'entries');
  const finalizeAudits = auditEntries.filter(entry => entry.action === 'event.finalize');
  assert.equal(finalizeAudits.length, 1, 'idempotent event finalization must write one audit entry');
});

test('ACC-022/023 championship always counts Cannon plus best three fields and excludes ineligible podium entries', async () => {
  requireTarget();
  const cases = (await fixture('standings-cases.json')).cases;
  for (const scenario of cases) {
    await request('/api/admin/acceptance/placements', { method: 'POST', headers: organizer(), body: { participantId: world.participants[cases.indexOf(scenario)].id, ...scenario } }, [200, 201]);
  }
  const { data } = await request('/api/standings/championship');
  const standings = list(data, 'standings');
  for (const scenario of cases) {
    const participantId = world.participants[cases.indexOf(scenario)].id;
    const row = standings.find(item => item.participantId === participantId);
    assert.ok(row, `missing standings row for ${scenario.key}`);
    assert.equal(row.total, scenario.expected.total);
    assert.deepEqual(row.countedFieldPoints, scenario.expected.counted);
    assert.deepEqual(row.droppedFieldPoints, scenario.expected.dropped);
    assert.equal(row.eligible, scenario.expected.eligible);
  }
  const podium = list(data, 'podium');
  assert.ok(podium.every(row => row.eligible), 'ineligible competitor occupies championship podium');
});

test('ACC-024/025 Flair rejects self/duplicate props; final vote is one per voter worth three and cannot alter championship', async () => {
  requireTarget();
  const publicParticipants = list((await request('/api/participants')).data, 'participants');
  const activeIds = new Set(publicParticipants.filter(person => person.active !== false && person.active !== 0).map(person => person.id));
  const [giver, recipient] = world.participants.filter(person => activeIds.has(person.id)).slice(0, 2);
  assert.ok(giver?.token && recipient?.token, 'Flair setup requires two active participants');
  const championshipBefore = (await request('/api/standings/championship')).data;
  await expectDenied('/api/flair/props', { method: 'POST', headers: bearer(giver.token), body: { recipientId: giver.id, category: 'Best Costume', idempotencyKey: `self-${RUN}` } });
  const prop = { recipientId: recipient.id, category: 'Best Costume', idempotencyKey: `prop-${RUN}` };
  await request('/api/flair/props', { method: 'POST', headers: bearer(giver.token), body: prop }, [200, 201]);
  await request('/api/flair/props', { method: 'POST', headers: bearer(giver.token), body: prop }, [200, 201]);
  await expectDenied('/api/flair/props', { method: 'POST', headers: bearer(giver.token), body: { ...prop, idempotencyKey: `duplicate-${RUN}` } });
  const vote = { recipientId: recipient.id, idempotencyKey: `vote-${RUN}` };
  await request('/api/flair/showboat-vote', { method: 'PUT', headers: bearer(giver.token), body: vote }, [200, 201]);
  await request('/api/flair/showboat-vote', { method: 'PUT', headers: bearer(giver.token), body: vote }, [200]);
  const { data } = await request('/api/standings/flair');
  const row = list(data, 'standings').find(item => item.participantId === recipient.id);
  assert.equal(row.propPoints, 1);
  assert.equal(row.votePoints, 3);
  assert.equal(row.total, 4);
  assert.deepEqual((await request('/api/standings/championship')).data, championshipBefore, 'Flair changed championship standings');
});

test('ACC-026 restart preserves committed identity/state and idempotent confirmation advances once', async () => {
  requireTarget();
  const participant = world.participants[0];
  const before = await matchState(world.confirmedMatch.id);
  await restartImportedApp();
  const restored = (await request('/api/me', { headers: bearer(participant.token) })).data.participant;
  assert.equal(restored.id, participant.id);
  await request(`/api/matches/${world.confirmedMatch.id}/result-confirmations`, {
    method: 'POST', headers: bearer(world.confirmation.token), body: world.confirmation.body,
  }, [200, 201]);
  const afterState = await matchState(world.confirmedMatch.id);
  assert.equal(afterState.winnerTeamId, before.winnerTeamId);
  assert.equal(afterState.advancementCount ?? 1, 1);
});

test('ACC-027 organizer backup and JSON/CSV export contain current state; destructive restore is explicit and audited', async () => {
  requireTarget();
  const { data: backupData } = await request('/api/admin/backups', { method: 'POST', headers: organizer(), body: {} }, [200, 201]);
  const backup = backupData.backup ?? backupData; id(backup, 'backup');
  assert.ok(backup.createdAt && (backup.downloadUrl || backup.path));
  const json = await request('/api/admin/export.json', { headers: organizer() });
  assert.ok(json.text.includes(world.participants[0].displayName));
  const csv = await request('/api/admin/export.csv', { headers: { ...organizer(), Accept: 'text/csv' } });
  assert.match(csv.response.headers.get('content-type') ?? '', /csv/);
  assert.ok(csv.text.length > 20);
  const key = `restore-${RUN}`;
  await request('/api/admin/restores', { method: 'POST', headers: organizer(PAUL), body: { backupId: backup.id, confirm: true, idempotencyKey: key } }, [200, 201]);
  await request('/api/admin/restores', { method: 'POST', headers: organizer(PAUL), body: { backupId: backup.id, confirm: true, idempotencyKey: key } }, [200]);
  const { data: audit } = await request('/api/admin/audit', { headers: organizer() });
  const restores = list(audit, 'entries').filter(entry => entry.action === 'restore' && entry.idempotencyKey === key);
  assert.equal(restores.length, 1);
  assert.equal(restores[0].actor, 'Paul');
  assert.ok(restores[0].preDestructiveBackupId);
});

test('ACC-028/029 XSS remains inert on every HTML surface and empty/oversized inputs are rejected', async () => {
  requireTarget();
  const attack = `<script>globalThis.PWNED=1</script><img src=x onerror=alert(1)>`;
  const attacker = await signup(attack);
  for (const bad of ['', 'x'.repeat(257)]) await expectDenied('/api/participants', { method: 'POST', body: { displayName: bad } });
  const stationId = (await request('/api/stations')).data.stations?.[0]?.id ?? 'station-1';
  for (const route of ['/', '/organizer', `/station/${stationId}`, '/tv', '/print']) {
    const { response, text } = await request(route, { headers: { Accept: 'text/html' } });
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(text.includes('<script>globalThis.PWNED=1</script>'), false, `${route} renders executable participant script`);
    assert.equal(/<img\s+src=x\s+onerror=/i.test(text), false, `${route} renders executable event handler`);
    assert.ok(text.includes('&lt;script&gt;') || !text.includes(attacker), `${route} must escape or omit hostile name`);
  }
  assert.ok(attacker.token, 'hostile signup remains a valid safely encoded identity');
});

test('ACC-030 signup, organizer login, voting, and result-report bursts are rate-limited', async () => {
  requireTarget();
  await burstUntilLimited('signup', index => raw('/api/participants', {
    method: 'POST', body: { displayName: `Burst ${RUN} ${index}` },
  }), [201]);

  await burstUntilLimited('organizer login', index => raw('/api/admin/session', {
    method: 'POST', body: { organizer: 'Chris', credential: `wrong-${RUN}-${index}` },
  }), [400, 401, 403]);

  const voter = world.participants[2];
  const recipient = world.participants[3];
  await burstUntilLimited('Showboat voting', index => raw('/api/flair/showboat-vote', {
    method: 'PUT', headers: bearer(voter.token), body: { recipientId: recipient.id, idempotencyKey: `vote-burst-${RUN}-${index}` },
  }), [200, 201, 409, 422]);

  const match = world.confirmedMatch;
  const participant = world.participants.find(person => match.participantIds?.includes(person.id)) ?? world.participants[4];
  await burstUntilLimited('result reporting', index => raw(`/api/matches/${match.id}/result-reports`, {
    method: 'POST', headers: bearer(participant.token), body: { winnerTeamId: match.teamIds?.[0], idempotencyKey: `result-burst-${RUN}-${index}` },
  }), [200, 201, 400, 403, 409, 422]);
});

test('ACC-031/032 TV and station routes expose public operations without organizer mutation controls', async () => {
  requireTarget();
  const stations = list((await request('/api/stations')).data, 'stations');
  assert.ok(stations.length >= 2);
  const tv = await request('/tv', { headers: { Accept: 'text/html' } });
  for (const marker of ['signup', 'standings', 'match', 'cannon', 'flair']) assert.match(tv.text.toLowerCase(), new RegExp(marker), `/tv missing ${marker}`);
  assert.doesNotMatch(tv.text, /name=["']organizerCredential|data-action=["'](?:reset|restore|override)/i);
  const station = await request(`/station/${stations[0].id}`, { headers: { Accept: 'text/html' } });
  for (const marker of ['station check-in', 'printed station qr', 'competitor pass', 'station-match', 'station-check-in', 'station-page.js']) assert.ok(station.text.toLowerCase().includes(marker), `station view missing ${marker}`);
  for (const staleFixture of ['rusted legends', 'trash pandas', '04:12']) assert.ok(!station.text.toLowerCase().includes(staleFixture), `station view contains stale fixture ${staleFixture}`);
});

test('ACC-033 print routes hand off to the verified public packet without live-looking state or bearer secrets', async () => {
  requireTarget();
  for (const route of ['/print', '/print.html']) {
    const { response, text } = await request(route, { headers: { Accept: 'text/html' } });
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(text, /href=["']\/public-print-packet\.pdf["']/i, `${route} lacks verified PDF handoff`);
    assert.equal(containsSecret(text, world.participants.map(p => p.token)), false, `${route} leaked bearer token`);
    assert.doesNotMatch(text, /participant roster|station queues|last backup:|phase:\s*cannon complete/i, `${route} contains retired live-looking state`);
  }
  const packet = await request('/public-print-packet.pdf', { headers: { Accept: 'application/pdf' } });
  assert.match(packet.response.headers.get('content-type') ?? '', /application\/pdf/);
  assert.equal(packet.text.slice(0, 5), '%PDF-', 'verified packet is not a PDF');
  assert.equal(containsSecret(packet.text, world.participants.map(p => p.token)), false, 'verified packet leaked bearer token');
});
