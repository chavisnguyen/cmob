import type { QueuedMessage } from "./types";

export interface ComposerImageAttachment {
  id: string;
  path: string;
  previewUrl: string;
}

export interface SurfaceComposerState {
  draftText: string;
  images: ComposerImageAttachment[];
  queue: QueuedMessage[];
  queuePaused: boolean;
  chosenModel: string | null;
  chosenEffort: string | null;
}

const MAX_COMPOSER_SURFACES = 32;

const DEFAULT_COMPOSER_STATE: SurfaceComposerState = Object.freeze({
  draftText: "",
  images: [],
  queue: [],
  queuePaused: false,
  chosenModel: null,
  chosenEffort: null,
});

const storeBySurface = new Map<string, SurfaceComposerState>();
const listenersBySurface = new Map<string, Set<() => void>>();

function normalizeKey(surfaceKey: string | undefined): string {
  return surfaceKey && surfaceKey.trim().length > 0 ? surfaceKey : "default";
}

function notifySurface(key: string): void {
  const subs = listenersBySurface.get(key);
  if (!subs) return;
  for (const cb of subs) {
    cb();
  }
}

export function getComposerState(surfaceKey: string | undefined): SurfaceComposerState {
  const key = normalizeKey(surfaceKey);
  return storeBySurface.get(key) ?? DEFAULT_COMPOSER_STATE;
}

/**
 * Updates per-surface composer state. Returns any `previewUrl`s evicted by surface LRU limits
 * so the caller can revoke object URLs if needed.
 */
export function updateComposerState(
  surfaceKey: string | undefined,
  updater: (prev: SurfaceComposerState) => SurfaceComposerState,
): string[] {
  const key = normalizeKey(surfaceKey);
  const prev = storeBySurface.get(key) ?? DEFAULT_COMPOSER_STATE;
  const next = updater(prev);
  if (next === prev) return [];

  storeBySurface.delete(key);
  storeBySurface.set(key, next);

  const evictedPreviewUrls: string[] = [];
  while (storeBySurface.size > MAX_COMPOSER_SURFACES) {
    const oldestKey = storeBySurface.keys().next().value;
    if (oldestKey === undefined) break;
    const evicted = storeBySurface.get(oldestKey);
    storeBySurface.delete(oldestKey);
    if (evicted) {
      for (const img of evicted.images) {
        evictedPreviewUrls.push(img.previewUrl);
      }
    }
  }

  notifySurface(key);
  return evictedPreviewUrls;
}

export function subscribeComposerState(
  surfaceKey: string | undefined,
  listener: () => void,
): () => void {
  const key = normalizeKey(surfaceKey);
  let subs = listenersBySurface.get(key);
  if (!subs) {
    subs = new Set();
    listenersBySurface.set(key, subs);
  }
  subs.add(listener);
  return () => {
    subs?.delete(listener);
    if (subs && subs.size === 0) {
      listenersBySurface.delete(key);
    }
  };
}

export function clearComposerStoreForTests(): void {
  const keys = Array.from(storeBySurface.keys());
  storeBySurface.clear();
  for (const k of keys) {
    notifySurface(k);
  }
}
