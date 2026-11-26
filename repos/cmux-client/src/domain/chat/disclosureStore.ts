/**
 * Scoped LRU disclosure store (`MAX_DISCLOSURES = 512` per surface) so virtualizer unmount
 * and `Chat | Term` tab switches never collapse expanded Reasoning, WorkRun/ToolRun, Diff,
 * Subagents, BackgroundTasks, CollapsibleText, or ComposerTray rows.
 */

export const MAX_DISCLOSURES = 512;
const MAX_SURFACES = 32;

const surfaceStores = new Map<string, Map<string, boolean>>();
const listeners = new Set<() => void>();

function normalizeScope(surfaceKey: string | undefined): string {
  return surfaceKey && surfaceKey.trim().length > 0 ? surfaceKey : "default";
}

function getOrCreateSurfaceMap(scope: string): Map<string, boolean> {
  let map = surfaceStores.get(scope);
  if (map) {
    surfaceStores.delete(scope);
    surfaceStores.set(scope, map);
    return map;
  }
  map = new Map<string, boolean>();
  surfaceStores.set(scope, map);
  while (surfaceStores.size > MAX_SURFACES) {
    const oldest = surfaceStores.keys().next().value;
    if (oldest === undefined) break;
    surfaceStores.delete(oldest);
  }
  return map;
}

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function getDisclosureState(
  surfaceKey: string | undefined,
  itemKey: string,
  defaultOpen = false,
): boolean {
  const scope = normalizeScope(surfaceKey);
  const map = surfaceStores.get(scope);
  if (!map) return defaultOpen;
  const hit = map.get(itemKey);
  return hit !== undefined ? hit : defaultOpen;
}

export function setDisclosureState(
  surfaceKey: string | undefined,
  itemKey: string,
  open: boolean,
): void {
  const scope = normalizeScope(surfaceKey);
  const map = getOrCreateSurfaceMap(scope);
  const prev = map.get(itemKey);
  map.delete(itemKey);
  map.set(itemKey, open);
  while (map.size > MAX_DISCLOSURES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  if (prev !== open) {
    emit();
  }
}

export function toggleDisclosureState(
  surfaceKey: string | undefined,
  itemKey: string,
  defaultOpen = false,
): boolean {
  const current = getDisclosureState(surfaceKey, itemKey, defaultOpen);
  const next = !current;
  setDisclosureState(surfaceKey, itemKey, next);
  return next;
}

export function subscribeDisclosure(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearDisclosureStoreForTests(): void {
  surfaceStores.clear();
  emit();
}
