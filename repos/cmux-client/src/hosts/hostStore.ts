/**
 * Saved gateway hosts (multi-host support).
 *
 * A host is an endpoint plus the credential for it. The store is a plain list in localStorage under one
 * key; every function takes the Storage so it can be unit tested. Orca keeps a similar host catalog
 * (ref/orca/mobile/src/host-catalog/host-store.ts) — this is a smaller web version of it.
 */

import { DEMO_HOSTS, isDemoMode } from "../demo/demoData";

export interface SavedHost {
  /** Stable id: the gateway WebSocket endpoint. */
  id: string;
  name: string;
  endpoint: string;
  token: string;
}

export type HostMachineType = "laptop" | "desktop" | "server";

const HOSTS_KEY = "cmux_hosts";
const ACTIVE_KEY = "cmux_active_host";

let memoryHostsFallback: SavedHost[] | null = null;
let memoryActiveFallback: string | null = null;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function isDefaultStorage(storage: StorageLike): boolean {
  try {
    return typeof localStorage !== "undefined" && storage === localStorage;
  } catch {
    return false;
  }
}

type HostsChangeListener = (hosts: SavedHost[], activeId: string | null) => void;
const listeners = new Set<HostsChangeListener>();

export function subscribeHosts(cb: HostsChangeListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function emitHostsChange(storage: StorageLike = localStorage): void {
  const hosts = loadHosts(storage);
  const activeId = getActiveHostId(storage);
  for (const listener of listeners) {
    try {
      listener(hosts, activeId);
    } catch {
      // ignore subscriber error
    }
  }
}

/** Classifies machine type to pick appropriate glyph (Laptop, Monitor, Server) like Orca. */
export function classifyHostType(nameOrEndpoint: string): HostMachineType {
  const lower = nameOrEndpoint.toLowerCase();
  if (
    lower.includes("server") ||
    lower.includes("linux") ||
    lower.includes("vps") ||
    lower.includes("aws") ||
    lower.includes("cloud") ||
    lower.includes("box") ||
    lower.includes("node") ||
    lower.includes("ubuntu") ||
    lower.includes("debian") ||
    lower.includes("fedora") ||
    lower.includes("arch")
  ) {
    return "server";
  }
  if (
    lower.includes("studio") ||
    lower.includes("imac") ||
    lower.includes("desktop") ||
    lower.includes("mini") ||
    lower.includes("pc") ||
    lower.includes("rig") ||
    lower.includes("tower") ||
    lower.includes("station")
  ) {
    return "desktop";
  }
  return "laptop";
}

export function sanitizeHostName(name: string): string {
  return (
    name
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1F\x7F-\x9F\r\n\t]/g, " ")
      .trim()
      .slice(0, 40)
  );
}

function isHost(v: unknown): v is SavedHost {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return false;
  }
  const h = v as Record<string, unknown>;
  return (
    typeof h.id === "string" &&
    typeof h.name === "string" &&
    typeof h.endpoint === "string" &&
    typeof h.token === "string"
  );
}

export function loadHosts(storage: StorageLike): SavedHost[] {
  try {
    const raw = storage.getItem(HOSTS_KEY);
    if (!raw) {
      if (isDemoMode()) return DEMO_HOSTS;
      return isDefaultStorage(storage) ? (memoryHostsFallback ?? []) : [];
    }
    const parsed: unknown = JSON.parse(raw);
    const valid = Array.isArray(parsed) ? parsed.filter(isHost) : [];
    if (valid.length > 0 && isDefaultStorage(storage)) memoryHostsFallback = valid;
    if (valid.length === 0 && isDemoMode()) return DEMO_HOSTS;
    return valid;
  } catch {
    if (isDemoMode()) return DEMO_HOSTS;
    return isDefaultStorage(storage) ? (memoryHostsFallback ?? []) : [];
  }
}

function saveHosts(storage: StorageLike, hosts: SavedHost[]): void {
  if (isDefaultStorage(storage)) {
    memoryHostsFallback = hosts;
  }
  try {
    storage.setItem(HOSTS_KEY, JSON.stringify(hosts));
  } catch {
    // Storage may be unavailable (private mode); memoryHostsFallback preserves them for this session
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
  if (!input.endpoint || typeof input.endpoint !== "string") {
    return loadHosts(storage);
  }
  const hosts = loadHosts(storage);
  const existing = hosts.find((h) => h.id === input.endpoint);
  const cleanName = input.name ? sanitizeHostName(input.name) : undefined;
  if (existing) {
    if (input.token) existing.token = input.token;
    if (cleanName) existing.name = cleanName;
  } else {
    hosts.push({
      id: input.endpoint,
      name: cleanName || hostNameFromEndpoint(input.endpoint),
      endpoint: input.endpoint,
      token: input.token,
    });
  }
  saveHosts(storage, hosts);
  emitHostsChange(storage);
  return hosts;
}

export function removeHost(storage: StorageLike, id: string): SavedHost[] {
  const hosts = loadHosts(storage).filter((h) => h.id !== id);
  saveHosts(storage, hosts);
  const active = getActiveHostId(storage);
  if (active === id) {
    const nextActive = hosts[0]?.id ?? "";
    if (isDefaultStorage(storage)) {
      memoryActiveFallback = nextActive;
    }
    try {
      storage.setItem(ACTIVE_KEY, nextActive);
    } catch {
      // ignore
    }
  }
  emitHostsChange(storage);
  return hosts;
}

export function renameHost(storage: StorageLike, id: string, name: string): SavedHost[] {
  const sanitized = sanitizeHostName(name);
  if (!sanitized) return loadHosts(storage);
  const hosts = loadHosts(storage);
  const host = hosts.find((h) => h.id === id);
  if (host) host.name = sanitized;
  saveHosts(storage, hosts);
  emitHostsChange(storage);
  return hosts;
}

export function getActiveHostId(storage: StorageLike): string | null {
  try {
    const val = storage.getItem(ACTIVE_KEY);
    if (!val && isDemoMode()) return DEMO_HOSTS[0].id;
    return (
      val ??
      (isDefaultStorage(storage)
        ? (memoryActiveFallback ?? (isDemoMode() ? DEMO_HOSTS[0].id : null))
        : null)
    );
  } catch {
    return isDefaultStorage(storage)
      ? (memoryActiveFallback ?? (isDemoMode() ? DEMO_HOSTS[0].id : null))
      : null;
  }
}

export function setActiveHostId(storage: StorageLike, id: string): void {
  if (isDefaultStorage(storage)) {
    memoryActiveFallback = id;
  }
  try {
    storage.setItem(ACTIVE_KEY, id);
    emitHostsChange(storage);
  } catch {
    emitHostsChange(storage);
  }
}
