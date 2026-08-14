function participantMatch(match, participantId, state) {
  const teamIds = [match.teamAId, match.teamBId];
  const myTeamIds = new Set((state.teamMembers ?? [])
    .filter(member => member.participantId === participantId && member.active !== 0)
    .map(member => member.teamId));
  return teamIds.some(teamId => myTeamIds.has(teamId));
}

function decorateMatch(match, participantId, state) {
  const teams = state.teams ?? [];
  const participants = state.participants ?? [];
  const members = state.teamMembers ?? [];
  const event = (state.events ?? []).find(item => item.id === match.eventId);
  const station = (state.stations ?? []).find(item => item.id === match.stationId);
  const team = id => teams.find(item => item.id === id) ?? { id, name: 'Team not assigned' };
  const names = id => members.filter(member => member.teamId === id && member.active !== 0)
    .map(member => participants.find(person => person.id === member.participantId)?.displayName)
    .filter(Boolean);
  const a = team(match.teamAId);
  const b = team(match.teamBId);
  const reporterTeamId = match.reporterId
    ? [a.id, b.id].find(id => members.some(member => member.teamId === id && member.participantId === match.reporterId))
    : null;
  return {
    ...match,
    eventName: event?.name ?? 'Event',
    stationName: station?.name ?? 'Station to be announced',
    teamA: { ...a, names: names(a.id) },
    teamB: { ...b, names: names(b.id) },
    myTeamId: [a.id, b.id].find(id => members.some(member => member.teamId === id && member.participantId === participantId)),
    reporterTeamId,
  };
}

export function buildParticipantFeed({ demoMode = false, liveData = null, demoData = null } = {}) {
  if (demoMode) {
    const source = demoData ?? {};
    return {
      mode: 'demo',
      name: source.me?.name ?? 'Demo competitor',
      activeMatch: source.activeMatch ?? null,
      events: source.events ?? [],
      results: source.events?.filter(event => /complete/i.test(event.status ?? '')) ?? [],
      standings: source.standings ?? [],
      flair: source.me?.flair ?? 0,
      progress: { complete: source.events?.filter(event => /complete/i.test(event.status ?? '')).length ?? 0, total: source.events?.length ?? 0 },
    };
  }
  if (!liveData?.participant) {
    return { mode: 'empty', name: 'Competitor', activeMatch: null, events: [], results: [], standings: [], flair: 0, progress: { complete: 0, total: 0 } };
  }
  const participant = liveData.participant;
  const state = liveData.state ?? {};
  const mine = (state.matches ?? []).filter(match => participantMatch(match, participant.id, state));
  const currentStatuses = ['CALLED', 'ACTIVE', 'AWAITING_CONFIRMATION', 'DISPUTED'];
  const current = currentStatuses.map(status => mine.find(match => String(match.status).toUpperCase() === status)).find(Boolean);
  const results = mine.filter(match => ['FINAL', 'CONFIRMED', 'COMPLETED'].includes(String(match.status).toUpperCase()));
  return {
    mode: 'live',
    name: participant.displayName,
    activeMatch: current ? decorateMatch(current, participant.id, state) : null,
    events: liveData.events ?? [],
    results: results.map(match => decorateMatch(match, participant.id, state)),
    standings: liveData.standings ?? [],
    flair: liveData.flair ?? 0,
    progress: { complete: results.length, total: liveData.events?.length ?? 0 },
  };
}
