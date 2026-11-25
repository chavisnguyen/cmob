import { useCallback, useEffect, useRef, useState } from "react";
import { RPC_METHODS, type UsageSnapshot } from "../../protocol/rpc";
import { wsClient, type ConnectionState } from "../../transport/wsClient";

const DEFAULT_POLL_MS = 45_000;
const TICK_MS = 30_000;

export interface UseUsageSnapshotResult {
  snapshot: UsageSnapshot | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  unsupported: boolean;
  now: number;
  refresh: () => Promise<void>;
}

/**
 * Fetches and polls real-time provider quota usage only while `enabled` and the tab is visible,
 * matching Orca's background-budget guard (`service-polling.ts:56-69`).
 */
export function useUsageSnapshot({
  enabled,
  connState,
  hostKey,
  pollMs = DEFAULT_POLL_MS,
}: {
  enabled: boolean;
  connState: ConnectionState;
  hostKey: string;
  pollMs?: number;
}): UseUsageSnapshotResult {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const inFlightRef = useRef(false);
  const snapshotRef = useRef<UsageSnapshot | null>(null);

  useEffect(() => {
    snapshotRef.current = null;
    setSnapshot(null);
    setError(null);
    setUnsupported(false);
  }, [hostKey]);

  const fetchUsage = useCallback(async (forceRefresh: boolean) => {
    if (wsClient.getState() !== "connected" || inFlightRef.current) return;
    inFlightRef.current = true;
    if (forceRefresh) setRefreshing(true);
    else setLoading((prev) => prev || snapshotRef.current === null);
    setError(null);
    try {
      const res = await wsClient.call<UsageSnapshot>(
        RPC_METHODS.USAGE_GET,
        { refresh: forceRefresh },
        { timeoutMs: 30_000 },
      );
      snapshotRef.current = res;
      setSnapshot(res);
      setUnsupported(false);
      setNow(Date.now());
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not load usage.";
      if (msg.toLowerCase().includes("method not found") || msg.includes("-32601")) {
        setUnsupported(true);
      } else {
        setError(msg);
      }
    } finally {
      inFlightRef.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled || connState !== "connected") return;
    void fetchUsage(false);

    const pollTimer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        void fetchUsage(false);
      }
    }, pollMs);

    const tickTimer = setInterval(() => {
      setNow(Date.now());
    }, TICK_MS);

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        setNow(Date.now());
        void fetchUsage(false);
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      clearInterval(pollTimer);
      clearInterval(tickTimer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [enabled, connState, hostKey, pollMs, fetchUsage]);

  const refresh = useCallback(async () => {
    await fetchUsage(true);
  }, [fetchUsage]);

  return { snapshot, loading, refreshing, error, unsupported, now, refresh };
}
