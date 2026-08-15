export interface CarouselPhoto {
  id: string;
  version?: string;
  contentVersion?: string;
  imageUrl: string;
  [key: string]: unknown;
}

export interface CarouselPhotoInput {
  enabled?: boolean;
  photos?: CarouselPhoto[];
  offline?: boolean;
  soundPrompt?: boolean;
  called?: boolean;
  active?: boolean;
  result?: boolean;
  [key: string]: unknown;
}

export function chooseCarouselPhoto(input?: CarouselPhotoInput, index?: number): CarouselPhoto | null;
export function createCarouselPhotoController(options?: { now?: () => number; rotationMs?: number }): {
  update(input?: CarouselPhotoInput): CarouselPhoto | null;
  cachedKeys(): string[];
};

export const chooseIdlePhoto: typeof chooseCarouselPhoto;
export const createIdlePhotoController: typeof createCarouselPhotoController;
