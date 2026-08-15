export const PHOTO_CONSENT_VERSION = 'junkyard-photo-consent-v1';

const SERVER_PHASES = new Map([
  ['UPLOADED', 'processing'],
  ['PROCESSING', 'processing'],
  ['PENDING_REVIEW', 'pending_review'],
  ['PUBLISHED', 'published'],
  ['REJECTED', 'rejected'],
  ['REMOVED', 'removed'],
  ['REMOVAL_REQUESTED', 'removal_requested'],
  ['DELETION_REQUESTED', 'removal_requested'],
]);

export function createPhotoUploadState() {
  return { phase: 'empty', progress: 0, previewUrl: '', consentAccepted: false, canUpload: false, photo: null, message: '' };
}

function withEligibility(state) {
  return { ...state, canUpload: Boolean(state.previewUrl && state.consentAccepted && !['uploading', 'processing'].includes(state.phase)) };
}

export function reducePhotoUpload(state, event) {
  switch (event.type) {
    case 'SELECT':
      return withEligibility({ ...state, phase: 'ready', previewUrl: event.previewUrl || '', progress: 0, message: '' });
    case 'CONSENT':
      return withEligibility({ ...state, consentAccepted: event.accepted === true });
    case 'UPLOAD_PROGRESS':
      return { ...state, phase: 'uploading', progress: Math.max(0, Math.min(100, Number(event.progress) || 0)), canUpload: false, message: 'Uploading securely…' };
    case 'SERVER_STATE': {
      const raw = String(event.photo?.state ?? '').toUpperCase();
      const phase = SERVER_PHASES.get(raw) ?? 'error';
      return { ...state, phase, progress: phase === 'processing' ? 100 : state.progress, photo: event.photo ?? null, canUpload: false, message: phase === 'error' ? 'The server returned an unknown photo state.' : '' };
    }
    case 'ERROR':
      return { ...state, phase: 'error', canUpload: Boolean(state.previewUrl && state.consentAccepted), message: event.message || 'Photo request failed.' };
    case 'RESET':
      return createPhotoUploadState();
    default:
      return state;
  }
}

const PHASE_COPY = {
  empty: 'Choose a photo from your camera or gallery.',
  ready: 'Ready when consent is confirmed.',
  uploading: 'Uploading securely…',
  processing: 'Upload received. Local safety screening is running.',
  pending_review: 'Pending organizer review. It is private unless approved.',
  published: 'Approved for the idle Junkyard Constellation reel.',
  rejected: 'This photo was not published. No moderation details are shared here.',
  removed: 'This photo has been removed from Junkyard Constellation.',
  removal_requested: 'Removal requested. An organizer will complete deletion.',
  error: 'Photo request failed. Check the local connection and try again.',
};

export function photoStatusCopy(state) {
  return state.message || PHASE_COPY[state.phase] || PHASE_COPY.error;
}

export function initPhotoUpload({ api, demo = false, root = document }) {
  const q = selector => root.querySelector(selector);
  const input = q('#photo-file');
  if (!input) return () => {};
  const names = q('#photo-names');
  const consent = q('#photo-consent');
  const upload = q('#photo-submit');
  const preview = q('#photo-preview');
  const progress = q('#photo-progress');
  const status = q('#photo-status');
  const removal = q('#photo-removal-request');
  let selectedFile = null;
  let previewUrl = '';
  let state = createPhotoUploadState();
  let pollTimer = null;

  const render = () => {
    preview.hidden = !state.previewUrl;
    if (state.previewUrl) preview.src = state.previewUrl;
    progress.hidden = state.phase !== 'uploading';
    progress.value = state.progress;
    upload.disabled = !state.canUpload || demo;
    status.textContent = demo ? 'Demo preview only — photo uploads are disabled.' : photoStatusCopy(state);
    status.dataset.phase = state.phase;
    removal.hidden = !['processing', 'published', 'pending_review', 'rejected', 'removed'].includes(state.phase) || !state.photo?.id;
    removal.disabled = demo || state.phase === 'removal_requested';
  };

  const applyPhoto = photo => { state = reducePhotoUpload(state, { type: 'SERVER_STATE', photo }); render(); };
  async function restoreLatestPhoto() {
    if (demo) return;
    try {
      const result = await api.getMyPhotos();
      const photos = result?.photos ?? (Array.isArray(result) ? result : []);
      if (photos[0]) {
        applyPhoto(photos[0]);
        if (['processing', 'pending_review'].includes(state.phase)) pollTimer = setTimeout(poll, 5000);
      }
    } catch {
      state = reducePhotoUpload(state, { type: 'ERROR', message: 'Photo status is unavailable. Check your competitor pass and local connection.' });
      render();
    }
  }
  const poll = async () => {
    if (demo || !state.photo?.id) return;
    try {
      const result = await api.getMyPhotos();
      const photos = result?.photos ?? (Array.isArray(result) ? result : []);
      const current = photos.find(photo => photo.id === state.photo.id);
      if (current) applyPhoto(current);
      if (['processing', 'pending_review'].includes(state.phase)) pollTimer = setTimeout(poll, 5000);
    } catch (error) {
      state = reducePhotoUpload(state, { type: 'ERROR', message: error.message });
      render();
    }
  };

  input.addEventListener('change', () => {
    selectedFile = input.files?.[0] ?? null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (!selectedFile) state = createPhotoUploadState();
    else if (!['image/jpeg', 'image/png', 'image/webp'].includes(selectedFile.type) || selectedFile.size > 8 * 1024 * 1024) {
      state = reducePhotoUpload(createPhotoUploadState(), { type: 'ERROR', message: 'Choose a JPEG, PNG, or WebP no larger than 8 MiB.' });
      selectedFile = null;
    } else {
      previewUrl = URL.createObjectURL(selectedFile);
      state = reducePhotoUpload(state, { type: 'SELECT', previewUrl });
      state = reducePhotoUpload(state, { type: 'CONSENT', accepted: consent.checked });
    }
    render();
  });
  consent.addEventListener('change', () => { state = reducePhotoUpload(state, { type: 'CONSENT', accepted: consent.checked }); render(); });
  upload.addEventListener('click', async () => {
    if (!state.canUpload || !selectedFile || demo) return;
    state = reducePhotoUpload(state, { type: 'UPLOAD_PROGRESS', progress: 15 }); render();
    try {
      state = reducePhotoUpload(state, { type: 'UPLOAD_PROGRESS', progress: 70 }); render();
      const result = await api.uploadPhoto({ file: selectedFile, names: names.value.trim(), consentAccepted: true, consentVersion: PHOTO_CONSENT_VERSION });
      applyPhoto(result.photo ?? result);
      poll();
    } catch (error) {
      state = reducePhotoUpload(state, { type: 'ERROR', message: error.message }); render();
    }
  });
  removal.addEventListener('click', async () => {
    if (!state.photo?.id || demo || !confirm('Request deletion of this photo? It will be removed from public display.')) return;
    try { applyPhoto((await api.requestPhotoRemoval(state.photo.id)).photo ?? { ...state.photo, state: 'REMOVAL_REQUESTED' }); }
    catch (error) { state = reducePhotoUpload(state, { type: 'ERROR', message: error.message }); render(); }
  });
  render();
  void restoreLatestPhoto();
  return () => { if (previewUrl) URL.revokeObjectURL(previewUrl); if (pollTimer) clearTimeout(pollTimer); };
}
