import {
  authorizedHeaders,
  canPersistParticipantToken,
  clearParticipantToken,
  getParticipantToken,
  storeParticipantToken,
} from './auth.js';

const DEMO = new URLSearchParams(location.search).get('demo') === '1';
const RECOVERY_MESSAGE = 'Identity was created, but this browser could not save it. Keep this page open and transfer or recover this participant before leaving.';

function validateApiPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/api/')) {
    throw new TypeError('Requests must use a same-origin relative /api/ path');
  }
  const parsed = new URL(path, location.origin);
  if (parsed.origin !== location.origin || !parsed.pathname.startsWith('/api/') || parsed.pathname.includes('..')) {
    throw new TypeError('Requests must use a same-origin relative /api/ path');
  }
  return path;
}

function callerHeaders(input) {
  const headers = new Headers(input || {});
  if (headers.has('Authorization')) {
    throw new TypeError('Caller-provided Authorization is not allowed');
  }
  return Object.fromEntries(headers.entries());
}

async function request(path, options = {}, actor = null) {
  validateApiPath(path);
  const headers = { Accept: 'application/json', ...callerHeaders(options.headers) };
  let body = options.body;
  if (body && typeof body !== 'string') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  if (actor) Object.assign(headers, authorizedHeaders(actor));
  const response = await fetch(path, { credentials: 'same-origin', ...options, body, headers });
  if (!response.ok) throw new Error((await response.text()) || `${response.status} ${response.statusText}`);
  return response.status === 204 ? null : response.json();
}

export const api = {
  demo: DEMO,
  hasParticipantIdentity: () => Boolean(getParticipantToken()),
  getState: () => request('/api/state'),
  getEvents: () => request('/api/events'),
  getChampionshipStandings: () => request('/api/standings/championship'),
  getFlairStandings: () => request('/api/standings/flair'),
  signup: async (displayName, eventIds) => {
    if (!canPersistParticipantToken()) {
      const error = new Error('This browser cannot safely store your participant identity. Enable site storage before signing up.');
      error.code = 'PARTICIPANT_STORAGE_UNAVAILABLE';
      throw error;
    }
    const result = await request('/api/participants', { method: 'POST', body: { displayName, eventIds } });
    const stored = storeParticipantToken(result.token);
    if (stored.recoveryRequired) {
      return { ...result, recoveryRequired: true, recoveryMessage: RECOVERY_MESSAGE };
    }
    return { ...result, recoveryRequired: false };
  },
  getMe: () => request('/api/me', {}, 'participant'),
  updateMe: (patch) => request('/api/me', { method: 'PATCH', body: patch }, 'participant'),
  reportResult: (matchId, winningTeamId) => request(`/api/matches/${matchId}/report`, { method: 'POST', body: { winningTeamId } }, 'participant'),
  confirmResult: (matchId, agree) => request(`/api/matches/${matchId}/confirm`, { method: 'POST', body: { agree } }, 'participant'),
  checkInMatch: (matchId) => request(`/api/matches/${matchId}/check-in`, { method: 'POST' }, 'participant'),
  giveFlair: (recipientId, category) => request('/api/flair/props', { method: 'POST', body: { recipientId, category } }, 'participant'),
  showboatVote: (recipientId) => request('/api/flair/vote', { method: 'POST', body: { recipientId } }, 'participant'),
  depart: () => request('/api/me/depart', { method: 'POST' }, 'participant'),
  signOut: clearParticipantToken,
  organizer: (path, body, method = 'POST') => request(`/api/organizer/${path}`, { method, body }, 'organizer'),
  organizerRequest: (path, options = {}) => request(path, options, 'organizer'),

  cannonShot: (laneId, body) => request(`/api/cannon/lanes/${laneId}/shots`, { method: 'POST', body }, 'organizer'),
};

export function subscribe(onData) {
  if (DEMO || !('EventSource' in window)) return () => {};
  const stream = new EventSource('/api/events/stream');
  stream.onmessage = event => onData(JSON.parse(event.data));
  stream.onerror = () => document.documentElement.dataset.connection = 'reconnecting';
  stream.onopen = () => document.documentElement.dataset.connection = 'live';
  return () => stream.close();
}
