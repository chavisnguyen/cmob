import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getActiveHostId,
  hostNameFromEndpoint,
  loadHosts,
  removeHost as storeRemoveHost,
  renameHost as storeRenameHost,
  setActiveHostId,
  subscribeHosts,
  upsertHost as storeUpsertHost,
  type SavedHost,
} from "./hostStore";
import { wsClient, type ConnectionState } from "../transport/wsClient";

export interface UseHostsResult {
  hosts: SavedHost[];
  activeHostId: string;
  activeHost: SavedHost | null;
  connState: ConnectionState;
  switchHost: (host: SavedHost) => void;
  removeHost: (id: string) => void;
  renameHost: (id: string, name: string) => void;
  upsertHost: (input: { endpoint: string; token: string; name?: string }) => void;
}

export function useHosts(): UseHostsResult {
  const [hosts, setHosts] = useState<SavedHost[]>(() => {
    if (typeof localStorage === "undefined") return [];
    return loadHosts(localStorage);
  });
  const [activeHostId, setActiveId] = useState<string>(() => {
    if (typeof localStorage === "undefined") return wsClient.getEndpoint();
    return getActiveHostId(localStorage) || wsClient.getEndpoint();
  });
  const [connState, setConnState] = useState<ConnectionState>(() => wsClient.getState());

  useEffect(() => {
    const unsubHosts = subscribeHosts((nextHosts, nextActiveId) => {
      setHosts(nextHosts);
      if (nextActiveId !== undefined && nextActiveId !== null) {
        setActiveId(nextActiveId);
      }
    });

    const unsubState = wsClient.onStateChange((state) => {
      setConnState(state);
      // When connected, wsClient records the host into localStorage; reload to sync
      if (typeof localStorage !== "undefined") {
        setHosts(loadHosts(localStorage));
        const currentEndpoint = wsClient.getEndpoint();
        setActiveId(getActiveHostId(localStorage) || currentEndpoint);
      }
    });

    return () => {
      unsubHosts();
      unsubState();
    };
  }, []);

  const switchHost = useCallback((host: SavedHost) => {
    if (typeof localStorage !== "undefined") {
      setActiveHostId(localStorage, host.id);
    }
    setActiveId(host.id);
    wsClient.switchHost(host);
  }, []);

  const removeHost = useCallback((id: string) => {
    if (typeof localStorage === "undefined") return;
    const wasActive = (getActiveHostId(localStorage) || wsClient.getEndpoint()) === id;
    const remaining = storeRemoveHost(localStorage, id);
    if (!wasActive) return;
    // Removing the computer in use must also drop its live connection, not just the saved entry.
    const next = remaining[0];
    if (next) {
      setActiveId(next.id);
      wsClient.switchHost(next);
    } else {
      setActiveId("");
      wsClient.forgetHost();
    }
  }, []);

  const renameHost = useCallback((id: string, name: string) => {
    if (typeof localStorage === "undefined") return;
    storeRenameHost(localStorage, id, name);
  }, []);

  const upsertHost = useCallback((input: { endpoint: string; token: string; name?: string }) => {
    if (typeof localStorage === "undefined") return;
    storeUpsertHost(localStorage, input);
  }, []);

  // Ensure current active host has at least a fallback representation even if storage is empty
  const effectiveHosts = useMemo(() => {
    const currentEndpoint = wsClient.getEndpoint();
    if (hosts.length === 0 && currentEndpoint) {
      return [
        {
          id: currentEndpoint,
          name: hostNameFromEndpoint(currentEndpoint),
          endpoint: currentEndpoint,
          token: wsClient.getToken(),
        },
      ];
    }
    return hosts;
  }, [hosts]);

  const activeHost = useMemo(() => {
    const found = effectiveHosts.find(
      (h) => h.id === activeHostId || h.endpoint === wsClient.getEndpoint(),
    );
    if (found) return found;
    return effectiveHosts[0] ?? null;
  }, [effectiveHosts, activeHostId]);

  return {
    hosts: effectiveHosts,
    activeHostId: activeHost?.id || activeHostId,
    activeHost,
    connState,
    switchHost,
    removeHost,
    renameHost,
    upsertHost,
  };
}
