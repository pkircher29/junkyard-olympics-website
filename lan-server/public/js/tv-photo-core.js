const BLOCKERS = ['offline', 'soundPrompt', 'called', 'active', 'result'];
const SAFE_PHOTO_URL = /^\/api\/photo-wall\/photos\/[A-Za-z0-9_-]{1,128}\/image\?version=[A-Za-z0-9_-]{1,128}$/;
const validPhoto = photo => Boolean(
  photo &&
  photo.id &&
  (photo.version ?? photo.contentVersion) &&
  typeof photo.imageUrl === 'string' &&
  SAFE_PHOTO_URL.test(photo.imageUrl),
);
const keyOf = photo => `${photo.id}:${photo.version ?? photo.contentVersion}`;

export function chooseCarouselPhoto(input = {}, index = 0) {
  if (input.enabled === false || BLOCKERS.some(blocker => Boolean(input[blocker]))) return null;
  const photos = (input.photos ?? []).filter(validPhoto);
  return photos.length ? photos[Math.abs(index) % photos.length] : null;
}

export function createCarouselPhotoController({ now = () => Date.now(), rotationMs = 16_000 } = {}) {
  let currentKey = null;
  let lastRotation = null;
  let index = 0;
  let cache = new Map();

  return {
    update(input = {}) {
      const photos = (input.photos ?? []).filter(validPhoto);
      const nextCache = new Map(photos.map(photo => [keyOf(photo), photo]));
      cache = nextCache;
      const blocked = input.enabled === false || BLOCKERS.some(blocker => Boolean(input[blocker]));
      if (blocked || !photos.length) {
        currentKey = null;
        lastRotation = null;
        return null;
      }
      const time = now();
      const currentPosition = photos.findIndex(photo => keyOf(photo) === currentKey);
      if (currentPosition < 0) {
        index = Math.min(index, photos.length - 1);
        currentKey = keyOf(photos[index]);
        lastRotation = time;
      } else if (lastRotation !== null && time - lastRotation >= rotationMs) {
        const steps = Math.max(1, Math.floor((time - lastRotation) / rotationMs));
        index = (currentPosition + steps) % photos.length;
        currentKey = keyOf(photos[index]);
        lastRotation += steps * rotationMs;
      }
      return cache.get(currentKey) ?? null;
    },
    cachedKeys() { return [...cache.keys()]; },
  };
}

// Compatibility aliases for the unfinished Photo Vault branch. The TV uses the
// accurately named carousel API above; these can disappear when that branch is repaired.
export const chooseIdlePhoto = chooseCarouselPhoto;
export const createIdlePhotoController = createCarouselPhotoController;
