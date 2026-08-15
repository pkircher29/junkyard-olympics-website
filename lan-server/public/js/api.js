import {
  authorizedHeaders,
  canPersistParticipantToken,
  clearParticipantToken,
  getParticipantToken,
  storeParticipantToken,
} from './auth.js';

const DEMO = new URLSearchParams(location.search).get('demo') === '1';
const RECOVERY_MESSAGE = 'Identity was created, but this browser could not save it. Keep this page open and transfer or recover this participant before leaving.';

// Expected photo API contract (UI lane; backend integration may land independently):
// POST /api/photos multipart(photo,names,consentAccepted,consentVersion) -> { photo }
// GET /api/photos/mine -> { photos: ParticipantPhoto[] }
// POST /api/photos/:id/removal-request -> { photo }
// GET /api/organizer/photos -> { settings:{enabled}, pending:[], published:[], removed:[] }
// PATCH /api/organizer/photo-wall -> { settings } with { enabled }
// GET /api/organizer/photos/:id/preview -> image Blob
// POST /api/organizer/photos/:id/:action -> { photo }, action publish|reject|remove|restore|delete|ban-uploader
// GET /api/photo-wall -> { enabled, version, photos:[{id,version,imageUrl,title,caption,names?}] }
// Every path is same-origin. Participant/organizer bearer injection occurs only in request().
export const PHOTO_API_CONTRACT = Object.freeze({ consentVersion: 'junkyard-photo-consent-v1', maxBytes: 8 * 1024 * 1024, rotationMs: 12_000 });

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
  const { responseType = 'json', ...fetchOptions } = options;
  const headers = { Accept: responseType === 'blob' ? 'image/webp,image/*' : 'application/json', ...callerHeaders(fetchOptions.headers) };
  let body = fetchOptions.body;
  const multipart = typeof FormData !== 'undefined' && body instanceof FormData;
  if (body && typeof body !== 'string' && !multipart) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  if (actor) Object.assign(headers, authorizedHeaders(actor));
  const response = await fetch(path, { credentials: 'same-origin', ...fetchOptions, body, headers });
  if (!response.ok) throw new Error((await response.text()) || `${response.status} ${response.statusText}`);
  return response.status === 204 ? null : responseType === 'blob' ? response.blob() : response.json();
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
  uploadPhoto: ({ file, names = '', consentAccepted, consentVersion = PHOTO_API_CONTRACT.consentVersion }) => {
    const body = new FormData();
    body.append('photo', file);
    body.append('names', names);
    body.append('consentAccepted', String(consentAccepted === true));
    body.append('consentVersion', consentVersion);
    return request('/api/photos', { method: 'POST', body }, 'participant');
  },
  getMyPhotos: () => request('/api/photos/mine', {}, 'participant'),
  requestPhotoRemoval: photoId => request(`/api/photos/${encodeURIComponent(photoId)}/removal-request`, { method: 'POST', body: {} }, 'participant'),
  showboatVote: (recipientId) => request('/api/flair/vote', { method: 'POST', body: { recipientId } }, 'participant'),
  depart: () => request('/api/me/depart', { method: 'POST' }, 'participant'),
  signOut: clearParticipantToken,
  organizer: (path, body, method = 'POST') => request(`/api/organizer/${path}`, { method, body }, 'organizer'),
  organizerRequest: (path, options = {}) => request(path, options, 'organizer'),
  getPhotoModeration: () => request('/api/organizer/photos', {}, 'organizer'),
  getOrganizerPhotoPreview: photoId => request(`/api/organizer/photos/${encodeURIComponent(photoId)}/preview`, { responseType: 'blob' }, 'organizer'),
  setPhotoWallEnabled: enabled => request('/api/organizer/photo-wall', { method: 'PATCH', body: { enabled: enabled === true } }, 'organizer'),
  moderatePhoto: (photoId, action) => request(`/api/organizer/photos/${encodeURIComponent(photoId)}/${encodeURIComponent(action)}`, { method: 'POST', body: {} }, 'organizer'),
  getPhotoWall: () => request('/api/photo-wall'),
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
