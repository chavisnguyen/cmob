import { useEffect, useRef, useState } from "react";
import { Pin, RefreshCw, ChevronRight, QrCode, Loader2, Zap } from "lucide-react";
import type { WorkspaceNode } from "../protocol/rpc";
import type { ConnectionState } from "../transport/wsClient";
import { Pressable } from "../components/common/Pressable";
import { UnreadCountBadge } from "../components/common/UnreadCountBadge";
import { plainSnippet, shortPath } from "../components/chat/textUtils";

interface WorkspaceListViewProps {
  workspaces: WorkspaceNode[];
  loading: boolean;
  syncing?: boolean;
  onRefresh: () => void;
  onSelectWorkspace: (workspace: WorkspaceNode) => void;
  hostsCount?: number;
  connState?: ConnectionState;
  onPairHost?: () => void;
  selectedWorkspaceId?: string | null;
  hideOnboarding?: boolean;
}

export function WorkspaceListView({
  workspaces,
  loading,
  syncing = false,
  onRefresh,
  onSelectWorkspace,
  hostsCount,
  connState,
  onPairHost,
  selectedWorkspaceId = null,
  hideOnboarding = false,
}: WorkspaceListViewProps) {
  const PULL_TRIGGER = 64;
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (!refreshing) return;
    const t = setTimeout(() => setRefreshing(false), 1500);
    return () => clearTimeout(t);
  }, [refreshing]);
  const startY = useRef<number | null>(null);
  const onTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    startY.current = e.currentTarget.scrollTop === 0 ? e.touches[0].clientY : null;
  };
  const onTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (startY.current === null) return;
    const dy = e.touches[0].clientY - startY.current;
    setPull(dy > 0 ? Math.min(dy * 0.5, PULL_TRIGGER * 1.5) : 0);
  };
  const onTouchEnd = () => {
    if (pull >= PULL_TRIGGER && !loading && !hasNoHosts) {
      setRefreshing(true);
      onRefresh();
    }
    startY.current = null;
    setPull(0);
  };

  const isConnecting = connState === "connecting" || connState === "authenticating";
  const hasNoHosts =
    typeof hostsCount === "number" &&
    hostsCount === 0 &&
    connState !== "connected" &&
    !isConnecting;

  return (
    <div className="flex flex-col h-full w-full max-w-3xl lg:max-w-none mx-auto bg-bg text-fg">
      {hideOnboarding ? (
        <div className="flex items-center justify-between px-3.5 h-9 border-b border-white/[0.05] w-full shrink-0 select-none">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-dim">
              Workspaces · {workspaces.length}
            </span>
            {workspaces.length > 0 && (syncing || isConnecting) && (
              <span
                role="status"
                aria-live="polite"
                data-testid="workspaces-syncing-pill"
                className="inline-flex items-center gap-1 text-[11px] font-medium text-accent-soft shrink-0"
              >
                <Loader2 className="w-2.5 h-2.5 animate-spin shrink-0" />
                <span>{isConnecting ? "Connecting…" : "Syncing…"}</span>
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading || hasNoHosts}
            className="w-6 h-6 rounded-md hover:bg-white/[0.06] text-dim hover:text-fg-soft flex items-center justify-center transition-colors disabled:opacity-40"
            title="Refresh workspaces"
            aria-label="Refresh workspaces"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      ) : (
        <header className="flex items-center justify-between px-4 min-h-[48px] bg-bg border-b border-white/[0.06] w-full shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="text-[15.5px] font-semibold tracking-tight text-fg">Workspaces</h1>
            <span className="text-[12px] font-medium text-dim font-mono">{workspaces.length}</span>
            {workspaces.length > 0 && (syncing || isConnecting) && (
              <span
                role="status"
                aria-live="polite"
                data-testid="workspaces-syncing-pill"
                className="inline-flex items-center gap-1.5 px-2 h-5 rounded-full bg-white/[0.05] border border-white/[0.08] text-[11px] font-medium text-muted shrink-0"
              >
                <Loader2 className="w-2.5 h-2.5 animate-spin text-accent-soft shrink-0" />
                <span>{isConnecting ? "Connecting…" : "Syncing…"}</span>
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading || hasNoHosts}
            className="w-8 h-8 rounded-lg hover:bg-white/[0.06] active:opacity-75 text-muted hover:text-fg flex items-center justify-center transition-colors disabled:opacity-40"
            title="Refresh workspaces"
            aria-label="Refresh workspaces"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </header>
      )}

      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        className="flex-1 overflow-y-auto overscroll-contain scrollbar-sleek divide-y divide-white/[0.05] pb-[env(safe-area-inset-bottom,0px)]"
      >
        <div
          aria-hidden="true"
          style={{ height: refreshing ? 34 : pull }}
          className={`flex items-center justify-center overflow-hidden text-muted ${pull === 0 ? "transition-[height] duration-200" : ""}`}
        >
          <RefreshCw
            style={refreshing ? undefined : { transform: `rotate(${pull * 4}deg)` }}
            className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""} ${pull >= PULL_TRIGGER ? "text-accent-soft" : ""}`}
          />
        </div>

        {hasNoHosts && !loading && hideOnboarding && (
          <div className="px-6 py-12 text-center text-muted text-[13px]">
            No computer paired yet.
          </div>
        )}

        {hasNoHosts && !loading && !hideOnboarding && (
          <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <h2 className="text-[19px] font-semibold text-fg tracking-tight mb-2">
              Welcome to Cmob
            </h2>
            <p className="text-[13.5px] text-muted max-w-sm leading-relaxed mb-6">
              Connect your computer to monitor terminal workspaces and control coding agents like
              Claude Code, AGY, and Kiro from your phone.
            </p>
            {onPairHost && (
              <button
                type="button"
                onClick={onPairHost}
                className="inline-flex items-center gap-2 px-4 min-h-[42px] rounded-xl bg-accent hover:bg-accent-strong text-white text-[13.5px] font-semibold transition-colors cursor-pointer"
              >
                <QrCode className="w-4 h-4" />
                <span>Connect Your Computer</span>
              </button>
            )}
            <code className="mt-5 text-[12px] text-muted bg-white/[0.04] border border-white/[0.07] px-2.5 py-1 rounded-md">
              $ cmob qr --tailscale
            </code>
          </div>
        )}

        {!hasNoHosts && workspaces.length === 0 && !loading && (
          <div className="px-6 py-12 text-center text-muted text-[13.5px]">
            No active workspaces found in cmux.
          </div>
        )}

        {workspaces.map((ws) => {
          const isRunning = ws.status.toLowerCase() === "running";
          const isSelected = Boolean(selectedWorkspaceId && selectedWorkspaceId === ws.id);
          const surfaceCount = ws.surfaces.length;
          const accentBarColor = ws.color || (isSelected ? "#0A84FF" : undefined);

          return (
            <Pressable
              key={ws.id}
              onPress={() => onSelectWorkspace(ws)}
              aria-current={isSelected ? "true" : undefined}
              style={accentBarColor ? { boxShadow: `inset 3px 0 0 ${accentBarColor}` } : undefined}
              className={`flex items-center justify-between px-3.5 py-2.5 cursor-pointer transition-colors group ${
                isSelected ? "bg-white/[0.055]" : "hover:bg-white/[0.028] active:bg-white/[0.05]"
              }`}
            >
              <div className="min-w-0 flex-1 pr-2 space-y-1">
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <UnreadCountBadge count={ws.unread_count} size="sm" />
                    {ws.pinned && <Pin className="w-3 h-3 text-dim shrink-0" />}
                    <h2 className="text-[14px] font-semibold text-fg truncate leading-snug">
                      {ws.title}
                    </h2>
                  </div>
                  {surfaceCount > 0 && (
                    <span className="text-[11px] font-mono text-dim shrink-0 tabular-nums">
                      {surfaceCount} {surfaceCount === 1 ? "tab" : "tabs"}
                    </span>
                  )}
                </div>

                {ws.snippet && (
                  <p className="text-[12.5px] text-muted line-clamp-2 leading-[1.38]">
                    {plainSnippet(ws.snippet)}
                  </p>
                )}

                <div className="flex items-center gap-2 min-w-0 text-[11.5px] leading-none pt-0.5">
                  {isRunning && (
                    <span className="inline-flex items-center gap-1 font-medium text-[#0A84FF] shrink-0">
                      <Zap className="w-3 h-3 fill-current" />
                      <span>Running</span>
                    </span>
                  )}
                  <span
                    className="truncate min-w-0 flex-1 text-dim font-mono"
                    title={ws.current_directory}
                  >
                    {shortPath(ws.current_directory)}
                  </span>
                </div>
              </div>

              {!hideOnboarding && (
                <ChevronRight className="w-4 h-4 text-dim group-hover:text-muted transition-colors shrink-0" />
              )}
            </Pressable>
          );
        })}
      </div>
    </div>
  );
}
