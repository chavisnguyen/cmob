import { useCallback, useEffect, useRef, useState } from "react";
import type { CreateSurfaceParams } from "../components/surface/NewSurfaceModal";
import {
  clearSurfaceUnreadInWorkspaces,
  matchesSurfaceId,
  mergeWorkspaces,
} from "../domain/workspaceTree";
import { peekCachedWorkspaces, writeCachedWorkspaces } from "../hosts/workspaceCache";
import {
  RPC_EVENTS,
  RPC_METHODS,
  type SurfaceNode,
  type WorkspaceBootstrapPayload,
  type WorkspaceNode,
} from "../protocol/rpc";
import { wsClient, type ConnectionState } from "../transport/wsClient";

export function stripResolvedQueryParams(paramNames: readonly string[]): void {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    let changed = false;
    for (const name of paramNames) {
      if (url.searchParams.has(name)) {
        url.searchParams.delete(name);
        changed = true;
      }
    }
    if (changed) {
      window.history.replaceState(window.history.state ?? null, document.title, url.toString());
    }
  } catch {
    // Ignore malformed URLs in synthetic test environments
  }
}

export interface UseWorkspaceStoreOptions {
  connState: ConnectionState;
  onWorkspacesReconcile: (workspaces: WorkspaceNode[], hasPendingJump: boolean) => void;
  onJumpToSurface: (surfaceId: string) => boolean;
}

export function useWorkspaceStore({
  connState,
  onWorkspacesReconcile,
  onJumpToSurface,
}: UseWorkspaceStoreOptions) {
  const [workspaces, setWorkspaces] = useState<WorkspaceNode[]>(() =>
    peekCachedWorkspaces(wsClient.getEndpoint()),
  );
  const [loading, setLoading] = useState(false);
  const [liveConfirmed, setLiveConfirmed] = useState(false);

  const workspacesRef = useRef(workspaces);
  const liveConfirmedRef = useRef(false);
  const fetchSeqRef = useRef(0);
  const inFlightEndpointRef = useRef<string | null>(null);
  const pendingSurfaceJumpRef = useRef<string | null>(null);

  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);

  useEffect(() => {
    if (connState !== "connected") {
      liveConfirmedRef.current = false;
      setLiveConfirmed(false);
    }
  }, [connState]);

  // Seed initial cold-start `?surface=<id>` deep-link target.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const urlSurfaceId = new URLSearchParams(window.location.search).get("surface");
    if (urlSurfaceId) {
      pendingSurfaceJumpRef.current = urlSurfaceId;
      if (onJumpToSurface(urlSurfaceId)) {
        pendingSurfaceJumpRef.current = null;
        stripResolvedQueryParams(["surface"]);
      }
    }
  }, [onJumpToSurface]);

  const applyWorkspaceSnapshot = useCallback(
    (incoming: WorkspaceNode[], endpoint: string) => {
      const merged = mergeWorkspaces(workspacesRef.current, incoming);
      if (merged !== workspacesRef.current) {
        workspacesRef.current = merged;
        setWorkspaces(merged);
      }
      liveConfirmedRef.current = true;
      setLiveConfirmed(true);
      setLoading(false);
      writeCachedWorkspaces(endpoint, merged);
      onWorkspacesReconcile(merged, Boolean(pendingSurfaceJumpRef.current));
    },
    [onWorkspacesReconcile],
  );

  const fetchWorkspaces = useCallback(
    async (showSpinner = false) => {
      if (wsClient.getState() !== "connected") return;
      const reqEndpoint = wsClient.getEndpoint();
      // Only coalesce duplicate polls targeting the SAME endpoint; host switches fence immediately.
      if (inFlightEndpointRef.current === reqEndpoint && !showSpinner) return;

      const seq = ++fetchSeqRef.current;
      inFlightEndpointRef.current = reqEndpoint;
      const shouldShowLoading = showSpinner || workspacesRef.current.length === 0;
      if (shouldShowLoading) setLoading(true);

      try {
        const resp = await wsClient.call<{ workspaces: WorkspaceNode[] }>(
          RPC_METHODS.WORKSPACE_TREE,
        );
        // Fence against stale Host A responses resolving after switching to Host B.
        if (seq !== fetchSeqRef.current || wsClient.getEndpoint() !== reqEndpoint) {
          return;
        }
        if (resp?.workspaces) {
          applyWorkspaceSnapshot(resp.workspaces, reqEndpoint);
        }
      } catch (err) {
        if (seq === fetchSeqRef.current) {
          console.warn("Failed to fetch workspaces:", err);
        }
      } finally {
        if (seq === fetchSeqRef.current) {
          inFlightEndpointRef.current = null;
          if (shouldShowLoading) setLoading(false);
        }
      }
    },
    [applyWorkspaceSnapshot],
  );

  const resetWorkspacesForHost = useCallback((nextEndpoint?: string | null) => {
    fetchSeqRef.current += 1;
    inFlightEndpointRef.current = null;
    liveConfirmedRef.current = false;
    setLoading(false);
    setLiveConfirmed(false);
    const seeded = nextEndpoint ? peekCachedWorkspaces(nextEndpoint) : [];
    workspacesRef.current = seeded;
    setWorkspaces(seeded);
  }, []);

  const markSurfaceRead = useCallback((target: Pick<SurfaceNode, "id" | "ref"> | string) => {
    const next = clearSurfaceUnreadInWorkspaces(workspacesRef.current, target);
    if (next !== workspacesRef.current) {
      workspacesRef.current = next;
      setWorkspaces(next);
      writeCachedWorkspaces(wsClient.getEndpoint(), next);
    }
  }, []);

  useEffect(() => {
    if (connState !== "connected") return;

    let bootstrapFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const buffered = wsClient.consumeBufferedBootstrapPayload();
    if (buffered && Array.isArray(buffered.workspaces)) {
      applyWorkspaceSnapshot(buffered.workspaces, wsClient.getEndpoint());
    } else if (wsClient.isAwaitingBootstrapTree()) {
      if (workspacesRef.current.length === 0) setLoading(true);
      bootstrapFallbackTimer = setTimeout(() => {
        if (wsClient.isAwaitingBootstrapTree() || !liveConfirmedRef.current) {
          void fetchWorkspaces(false);
        }
      }, 1500);
    } else {
      void fetchWorkspaces(false);
    }

    const offBootstrap = wsClient.onEvent((event, data) => {
      if (event !== RPC_EVENTS.WORKSPACE_BOOTSTRAP || !data) return;
      if (bootstrapFallbackTimer) {
        clearTimeout(bootstrapFallbackTimer);
        bootstrapFallbackTimer = null;
      }
      wsClient.consumeBufferedBootstrapPayload();
      const payload = data as WorkspaceBootstrapPayload;
      if (Array.isArray(payload.workspaces)) {
        applyWorkspaceSnapshot(payload.workspaces, wsClient.getEndpoint());
      } else {
        void fetchWorkspaces(false);
      }
    });

    const interval = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        void fetchWorkspaces(false);
      }
    }, 5000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void fetchWorkspaces(false);
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      if (bootstrapFallbackTimer) clearTimeout(bootstrapFallbackTimer);
      offBootstrap();
      clearInterval(interval);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [connState, fetchWorkspaces, applyWorkspaceSnapshot]);

  // Resolve cold-start `?surface=<id>` once workspaces arrive and strip it from the address bar.
  useEffect(() => {
    const target = pendingSurfaceJumpRef.current;
    if (!target || workspaces.length === 0) return;
    const found = workspaces.some((ws) => ws.surfaces.some((s) => matchesSurfaceId(s, target)));
    if (found) {
      onJumpToSurface(target);
      pendingSurfaceJumpRef.current = null;
      stripResolvedQueryParams(["surface"]);
    }
  }, [workspaces, onJumpToSurface]);

  const createSurface = useCallback(
    async (params: CreateSurfaceParams) => {
      await wsClient.call(RPC_METHODS.SURFACE_NEW, {
        workspace_id: params.workspaceId,
        command: params.command,
        ...(params.launch ? { launch: params.launch } : {}),
      });
      await fetchWorkspaces();
    },
    [fetchWorkspaces],
  );

  const renameSurface = useCallback(
    async (surfaceId: string, title: string) => {
      await wsClient.call(RPC_METHODS.SURFACE_RENAME, {
        surface_id: surfaceId,
        title,
      });
      await fetchWorkspaces();
    },
    [fetchWorkspaces],
  );

  const closeSurface = useCallback(
    async (surfaceId: string, workspaceId?: string) => {
      await wsClient.call(RPC_METHODS.SURFACE_CLOSE, {
        surface_id: surfaceId,
        workspace_id: workspaceId,
        force: true,
      });
      await fetchWorkspaces();
    },
    [fetchWorkspaces],
  );

  const hasPendingSurfaceJump = useCallback(() => Boolean(pendingSurfaceJumpRef.current), []);

  const syncing = loading || (!liveConfirmed && workspaces.length > 0);

  return {
    workspaces,
    workspacesRef,
    loading,
    syncing,
    hasPendingSurfaceJump,
    fetchWorkspaces,
    resetWorkspacesForHost,
    markSurfaceRead,
    createSurface,
    renameSurface,
    closeSurface,
  };
}
