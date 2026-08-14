import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error browser module intentionally has no TypeScript declarations
import { buildParticipantFeed } from '../public/js/participant-feed.js';

const text = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function live(status: string, overrides: Record<string, unknown> = {}) {
  const participant = { id: 'p1', displayName: 'Phone Pat' };
  const state = {
    participants: [participant, { id: 'p2', displayName: 'Opponent Ollie' }],
    events: [{ id: 'ladder-ball', name: 'Ladder Ball', kind: 'HEAD_TO_HEAD' }],
    stations: [{ id: 'station-1', name: 'The Crusher' }],
    teams: [{ id: 'ta', name: 'Rust Raiders' }, { id: 'tb', name: 'Bent Axles' }],
    teamMembers: [
      { teamId: 'ta', participantId: 'p1', active: 1 },
      { teamId: 'tb', participantId: 'p2', active: 1 },
    ],
    matches: [{
      id: 'm1', eventId: 'ladder-ball', stationId: 'station-1', teamAId: 'ta', teamBId: 'tb',
      status, round: 1, reportedWinnerId: null, reporterId: null, ...overrides,
    }],
  };
  return buildParticipantFeed({ liveData: { participant, state, events: state.events, standings: [] } });
}

describe('event-day mobile operations contracts', () => {
  it('keeps every actionable match state on the participant feed', () => {
    for (const status of ['CALLED', 'ACTIVE', 'AWAITING_CONFIRMATION', 'DISPUTED']) {
      const feed = live(status);
      expect(feed.activeMatch?.id, status).toBe('m1');
      expect(feed.activeMatch?.status, status).toBe(status);
    }
    expect(live('FINAL').activeMatch).toBeNull();
  });

  it('decorates reported winner and reporter team for confirmation authorization', () => {
    const feed = live('AWAITING_CONFIRMATION', { reportedWinnerId: 'ta', reporterId: 'p1' });
    expect(feed.activeMatch).toMatchObject({ myTeamId: 'ta', reporterTeamId: 'ta', reportedWinnerId: 'ta' });
  });

  it('uses the canonical match check-in and agree confirmation contracts', () => {
    const api = text('public/js/api.js');
    expect(api).toContain('checkInMatch: (matchId)');
    expect(api).toContain('/api/matches/${matchId}/check-in');
    expect(api).toContain('body: { agree }');
    expect(api).not.toContain('body: { accepted }');
    expect(api).not.toContain('/api/stations/${stationId}/check-in');
  });

  it('makes the live station route a truthful participant-phone portal', () => {
    const html = text('public/station.html');
    const lower = html.toLowerCase();
    for (const fixture of ['rusted legends', 'trash pandas', 'rivet rosie', 'dumpster dan', '04:12', 'semifinal']) {
      expect(lower).not.toContain(fixture);
    }
    expect(html).toContain('id="station-match"');
    expect(html).toContain('id="station-check-in"');
    expect(html).toContain('/js/station-page.js');
  });

  it('provides real participant report, confirm, and dispute controls', () => {
    const html = text('public/participant.html');
    for (const id of ['match-action-panel', 'report-team-a', 'report-team-b', 'confirm-result', 'dispute-result']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).not.toContain('href="/station.html"');
  });

  it('keeps the desktop Control Yard sidebar inside its assigned grid track', () => {
    const css = text('public/styles.css');
    expect(css).toContain('.organizer-page .grid.sidebar>aside{grid-template-columns:minmax(0,1fr);min-width:0}');
    expect(css).toContain('.organizer-page .grid.sidebar>aside>.card{min-width:0;max-width:100%}');
  });

  it('guards signup when the browser already owns a participant pass', () => {
    const html = text('public/index.html');
    const js = text('public/js/signup-page.js');
    for (const id of ['existing-identity', 'existing-identity-name', 'continue-existing', 'switch-person']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(js).toContain('api.getMe()');
    expect(js).toContain("confirm(");
    expect(js).toContain('api.signOut()');
    expect(js).toContain('signupInFlight || signupCompleted || api.hasParticipantIdentity()');
    expect(js).toContain('signupCompleted = true');
  });
});
