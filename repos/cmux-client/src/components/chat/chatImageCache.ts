const MAX_ENTRIES = 24;
const cache = new Map<string, Promise<string>>();

/** Memoises image fetches by id (ids are transcript line uuids, so they are globally unique). */
export function cachedChatImage(id: string, load: () => Promise<string>): Promise<string> {
  const hit = cache.get(id);
  if (hit) {
    // Refresh recency.
    cache.delete(id);
    cache.set(id, hit);
    return hit;
  }
  const p = load().catch((err: unknown) => {
    cache.delete(id);
    throw err;
  });
  cache.set(id, p);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return p;
}
