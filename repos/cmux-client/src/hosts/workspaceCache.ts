import { isDemoMode } from "../demo/demoData";
import type { WorkspaceNode } from "../protocol/rpc";

const LEGACY_STORAGE_KEY = "cmux.workspaceTreeCache.v1";
const MAX_HOSTS = 6;

const memoryWorkspaces = new Map<string, WorkspaceNode[]>();
let purgedLegacyDiskCache = false;

function purgeLegacyDiskCacheOnce(): void {
  if (purgedLegacyDiskCache) return;
  purgedLegacyDiskCache = true;
  try {
    if (typeof window !== "undefined" && typeof window.localStorage?.removeItem === "function") {
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
  } catch {
    // Ignore restricted storage environments.
  }
}

export function workspaceCacheKey(endpoint: string | null | undefined): string {
  if (isDemoMode()) return "demo";
  return endpoint || "local";
}

/**
 * Session-scoped in-memory workspace tree cache (Orca Web pattern: zero localStorage I/O).
 * Keeps tab/view transitions instant within a running app session while guaranteeing cold opens
 * and reloads never display stale cross-session workspaces.
 */
export function peekCachedWorkspaces(endpoint: string | null | undefined): WorkspaceNode[] {
  purgeLegacyDiskCacheOnce();
  if (isDemoMode()) return [];
  const key = workspaceCacheKey(endpoint);
  const hit = memoryWorkspaces.get(key);
  if (!hit) return [];
  memoryWorkspaces.delete(key);
  memoryWorkspaces.set(key, hit);
  return hit;
}

export function writeCachedWorkspaces(
  endpoint: string | null | undefined,
  workspaces: WorkspaceNode[],
): void {
  purgeLegacyDiskCacheOnce();
  if (isDemoMode()) return;
  const key = workspaceCacheKey(endpoint);
  memoryWorkspaces.delete(key);
  memoryWorkspaces.set(key, workspaces);
  while (memoryWorkspaces.size > MAX_HOSTS) {
    const oldest = memoryWorkspaces.keys().next().value;
    if (oldest === undefined) break;
    memoryWorkspaces.delete(oldest);
  }
}

export function clearWorkspaceCacheForTests(): void {
  memoryWorkspaces.clear();
  purgedLegacyDiskCache = false;
}
