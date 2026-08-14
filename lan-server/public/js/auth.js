const ORGANIZER_KEY = 'junkyard-olympics:organizer-token';
const PARTICIPANT_KEY = 'junkyard-olympics:participant-token';
const MIN_TOKEN_LENGTH = 24;
const CREDENTIAL_QUERY_NAMES = new Set(['token', 'access_token', 'auth']);

let participantFallbackToken = null;
const storageState = {
  organizer: 'available',
  participant: 'available',
};

function validToken(value) {
  return typeof value === 'string' && value.length >= MIN_TOKEN_LENGTH && value.length <= 512;
}

function markUnavailable(actor) {
  storageState[actor] = 'unavailable';
}

function browserStorage(name, actor) {
  try {
    return globalThis[name];
  } catch {
    markUnavailable(actor);
    return null;
  }
}

function safeGet(storage, key, actor) {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    markUnavailable(actor);
    return null;
  }
}

function safeSet(storage, key, value, actor) {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    markUnavailable(actor);
    return false;
  }
}

function safeRemove(storage, key, actor) {
  if (!storage) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    markUnavailable(actor);
    return false;
  }
}

function sanitizeCredentialLocation() {
  const query = new URLSearchParams(location.search);
  let removedQueryCredential = false;
  for (const key of [...query.keys()]) {
    if (CREDENTIAL_QUERY_NAMES.has(key.toLowerCase())) {
      query.delete(key);
      removedQueryCredential = true;
    }
  }

  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = location.hash ? fragment.get('token') : null;
  if (location.hash || removedQueryCredential) {
    const cleanQuery = query.toString();
    history.replaceState(null, '', `${location.pathname}${cleanQuery ? `?${cleanQuery}` : ''}`);
  }
  return token;
}

function consumeOrganizerFragment() {
  const token = sanitizeCredentialLocation();
  if (validToken(token)) safeSet(browserStorage('sessionStorage', 'organizer'), ORGANIZER_KEY, token, 'organizer');
}

consumeOrganizerFragment();

export function getOrganizerToken() {
  const token = safeGet(browserStorage('sessionStorage', 'organizer'), ORGANIZER_KEY, 'organizer');
  return validToken(token) ? token : null;
}

export function getParticipantToken() {
  const token = safeGet(browserStorage('localStorage', 'participant'), PARTICIPANT_KEY, 'participant');
  if (validToken(token)) return token;
  return validToken(participantFallbackToken) ? participantFallbackToken : null;
}

export function canPersistParticipantToken() {
  const probeKey = `${PARTICIPANT_KEY}:storage-probe`;
  const storage = browserStorage('localStorage', 'participant');
  if (!safeSet(storage, probeKey, '1', 'participant')) return false;
  if (!safeRemove(storage, probeKey, 'participant')) return false;
  storageState.participant = 'available';
  return true;
}

export function storeParticipantToken(token) {
  if (!validToken(token)) throw new Error('Invalid participant credential');
  if (safeSet(browserStorage('localStorage', 'participant'), PARTICIPANT_KEY, token, 'participant')) {
    participantFallbackToken = null;
    return { persisted: true, recoveryRequired: false };
  }
  participantFallbackToken = token;
  return { persisted: false, recoveryRequired: true };
}

export function clearParticipantToken() {
  participantFallbackToken = null;
  return safeRemove(browserStorage('localStorage', 'participant'), PARTICIPANT_KEY, 'participant');
}

export function getCredentialStorageState() {
  return {
    organizer: storageState.organizer,
    participant: storageState.participant,
    participantFallback: validToken(participantFallbackToken),
  };
}

export function authorizedHeaders(actor) {
  const token = actor === 'organizer'
    ? getOrganizerToken()
    : actor === 'participant'
      ? getParticipantToken()
      : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}
