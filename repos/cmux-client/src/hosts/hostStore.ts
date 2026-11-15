/**
 * Saved gateway hosts (multi-host support).
 *
 * A host is an endpoint plus the credential for it. The store is a plain list in localStorage under one
 * key; every function takes the Storage so it can be unit tested. Orca keeps a similar host catalog
 * (ref/orca/mobile/src/host-catalog/host-store.ts) — this is a smaller web version of it.
 */

export interface SavedHost {
  /** Stable id: the gateway WebSocket endpoint. */
  id: string;
  name: string;
  endpoint: string;
  token: string;
}

const HOSTS_KEY = "cmux_hosts";
const ACTIVE_KEY = "cmux_active_host";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function isHost(v: unknown): v is SavedHost {
  const h = v as Partial<SavedHost> | null;
  return (
    !!h &&
    typeof h.id === "string" &&
    typeof h.name === "string" &&
    typeof h.endpoint === "string" &&
    typeof h.token === "string"
  );
}

export function loadHosts(storage: StorageLike): SavedHost[] {
  try {
    const raw = storage.getItem(HOSTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isHost) : [];
  } catch {
    return [];
  }
}

function saveHosts(storage: StorageLike, hosts: SavedHost[]): void {
  try {
    storage.setItem(HOSTS_KEY, JSON.stringify(hosts));
  } catch {
    // Storage may be unavailable (private mode); hosts then live for this session only.
  }
}

/** Default display name: the host part of the endpoint. */
export function hostNameFromEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/** Inserts or updates (by endpoint) a host. An empty token never overwrites a stored one. */
export function upsertHost(
  storage: StorageLike,
  input: { endpoint: string; token: string; name?: string },
): SavedHost[] {
  const hosts = loadHosts(storage);
  const existing = hosts.find((h) => h.id === input.endpoint);
  if (existing) {
    if (input.token) existing.token = input.token;
    if (input.name) existing.name = input.name;
  } else {
    hosts.push({
      id: input.endpoint,
      name: input.name || hostNameFromEndpoint(input.endpoint),
      endpoint: input.endpoint,
      token: input.token,
    });
  }
  saveHosts(storage, hosts);
  return hosts;
}

export function removeHost(storage: StorageLike, id: string): SavedHost[] {
  const hosts = loadHosts(storage).filter((h) => h.id !== id);
  saveHosts(storage, hosts);
  return hosts;
}

export function renameHost(storage: StorageLike, id: string, name: string): SavedHost[] {
  const trimmed = name.trim();
  const hosts = loadHosts(storage);
  const host = hosts.find((h) => h.id === id);
  if (host && trimmed) host.name = trimmed.slice(0, 40);
  saveHosts(storage, hosts);
  return hosts;
}

export function getActiveHostId(storage: StorageLike): string | null {
  try {
    return storage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function setActiveHostId(storage: StorageLike, id: string): void {
  try {
    storage.setItem(ACTIVE_KEY, id);
  } catch {
    // ignore
  }
}
