import { useCallback, useEffect, useRef, useState } from "react";
import { RPC_METHODS, type SpendPeriod, type SpendSnapshot } from "../../protocol/rpc";
import { wsClient, type ConnectionState } from "../../transport/wsClient";

const POLL_MS = 90_000;

export interface UseSpendSnapshotResult {
  snapshot: SpendSnapshot | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  unsupported: boolean;
  refresh: () => Promise<void>;
}

/**
 * Fetches `codeburn`-backed day/month spend for the selected period. Polls only while `enabled`
 * and the page is visible; results are cached per period so switching tabs is instant.
 */
export function useSpendSnapshot({
  enabled,
  connState,
  hostKey,
  period,
}: {
  enabled: boolean;
  connState: ConnectionState;
  hostKey: string;
  period: SpendPeriod;
}): UseSpendSnapshotResult {
  const [cache, setCache] = useState<Partial<Record<SpendPeriod, SpendSnapshot>>>({});
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const inFlightRef = useRef<Set<SpendPeriod>>(new Set());
  const hostRef = useRef(hostKey);

  useEffect(() => {
    hostRef.current = hostKey;
    setCache({});
    setError(null);
    setUnsupported(false);
    inFlightRef.current.clear();
  }, [hostKey]);

  const fetchSpend = useCallback(
    async (forceRefresh: boolean) => {
      if (wsClient.getState() !== "connected" || inFlightRef.current.has(period)) return;
      const startedFor = hostRef.current;
      inFlightRef.current.add(period);
      if (forceRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const res = await wsClient.call<SpendSnapshot>(
          RPC_METHODS.USAGE_SPEND,
          { period, refresh: forceRefresh },
          { timeoutMs: 60_000 },
        );
        if (hostRef.current !== startedFor) return;
        setCache((prev) => ({ ...prev, [period]: res }));
        setUnsupported(false);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Could not load spend.";
        if (msg.toLowerCase().includes("method not found") || msg.includes("-32601")) {
          setUnsupported(true);
        } else {
          setError(msg);
        }
      } finally {
        inFlightRef.current.delete(period);
        setLoading(false);
        setRefreshing(false);
      }
    },
    [period],
  );

  useEffect(() => {
    if (!enabled || connState !== "connected") return;
    void fetchSpend(false);
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        void fetchSpend(false);
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, connState, hostKey, fetchSpend]);

  const refresh = useCallback(async () => {
    await fetchSpend(true);
  }, [fetchSpend]);

  return { snapshot: cache[period] ?? null, loading, refreshing, error, unsupported, refresh };
}
