import { isDemoMode } from "../demo/demoData";
import type { WorkspaceNode } from "../protocol/rpc";

const STORAGE_KEY = "cmux.workspaceTreeCache.v1";
const STORED_VERSION = 1;
const MAX_HOSTS = 6;

const memoryWorkspaces = new Map<string, WorkspaceNode[]>();
let hydrated = false;

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    if (typeof window.localStorage.getItem !== "function") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function hydrateOnce(): void {
  if (hydrated) return;
  hydrated = true;
  const storage = safeStorage();
  if (!storage) return;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as {
      v?: number;
      entries?: [string, WorkspaceNode[]][];
    };
    if (parsed?.v !== STORED_VERSION || !Array.isArray(parsed.entries)) return;
    for (const [key, list] of parsed.entries) {
      if (typeof key === "string" && Array.isArray(list) && !memoryWorkspaces.has(key)) {
        memoryWorkspaces.set(key, list);
      }
    }
  } catch {
    // Ignore corrupted or restricted storage.
  }
}

export function workspaceCacheKey(endpoint: string | null | undefined): string {
  if (isDemoMode()) return "demo";
  return endpoint || "local";
}

export function peekCachedWorkspaces(endpoint: string | null | undefined): WorkspaceNode[] {
  if (isDemoMode()) return [];
  hydrateOnce();
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
  if (isDemoMode()) return;
  hydrateOnce();
  const key = workspaceCacheKey(endpoint);
  memoryWorkspaces.delete(key);
  memoryWorkspaces.set(key, workspaces);
  while (memoryWorkspaces.size > MAX_HOSTS) {
    const oldest = memoryWorkspaces.keys().next().value;
    if (oldest === undefined) break;
    memoryWorkspaces.delete(oldest);
  }
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: STORED_VERSION,
        entries: Array.from(memoryWorkspaces.entries()),
      }),
    );
  } catch {
    // Non-fatal quota error.
  }
}

export function clearWorkspaceCacheForTests(): void {
  memoryWorkspaces.clear();
  hydrated = true;
  safeStorage()?.removeItem(STORAGE_KEY);
}
