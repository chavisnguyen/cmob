import { useEffect, useRef, useState } from "react";
import { ChevronRight, Loader2, Pin, QrCode, RefreshCw } from "lucide-react";
import { plainSnippet, shortPath } from "../components/chat/textUtils";
import { Pressable } from "../components/common/Pressable";
import { UnreadCountBadge } from "../components/common/UnreadCountBadge";
import type { WorkspaceNode } from "../protocol/rpc";
import type { ConnectionState } from "../transport/wsClient";

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

  const isSidebar = hideOnboarding;

  return (
    <div
      className={`flex flex-col h-full w-full max-w-3xl lg:max-w-none mx-auto text-fg ${
        isSidebar ? "bg-sidebar" : "bg-bg"
      }`}
    >
      {isSidebar ? (
        <div className="flex items-center justify-between px-3.5 h-[30px] border-b border-line w-full shrink-0 select-none">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-dim">
              Workspaces
            </span>
            <span className="text-[10.5px] font-mono text-dim tabular-nums">
              {workspaces.length}
            </span>
            {workspaces.length > 0 && (syncing || isConnecting) && (
              <span
                role="status"
                aria-live="polite"
                data-testid="workspaces-syncing-pill"
                className="inline-flex items-center gap-1 text-[10.5px] text-muted shrink-0"
              >
                <Loader2 className="w-2.5 h-2.5 animate-spin shrink-0" />
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading || hasNoHosts}
            className="w-5 h-5 rounded hover:bg-raised text-dim hover:text-fg-soft flex items-center justify-center transition-colors disabled:opacity-40"
            title="Refresh workspaces"
            aria-label="Refresh workspaces"
          >
            <RefreshCw className={`w-2.5 h-2.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      ) : (
        <header className="flex items-center justify-between px-4 h-[40px] bg-bg border-b border-line w-full shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="text-[13.5px] font-semibold tracking-tight text-fg">Workspaces</h1>
            <span className="text-[11.5px] text-dim font-mono tabular-nums">
              {workspaces.length}
            </span>
            {workspaces.length > 0 && (syncing || isConnecting) && (
              <span
                role="status"
                aria-live="polite"
                data-testid="workspaces-syncing-pill"
                className="inline-flex items-center gap-1 text-[11px] text-muted shrink-0"
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
            className="w-7 h-7 rounded-[6px] hover:bg-raised active:opacity-75 text-muted hover:text-fg flex items-center justify-center transition-colors disabled:opacity-40"
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
        className="flex-1 overflow-y-auto overscroll-contain scrollbar-sleek pb-[env(safe-area-inset-bottom,0px)]"
      >
        <div
          aria-hidden="true"
          style={{ height: refreshing ? 30 : pull }}
          className={`flex items-center justify-center overflow-hidden text-muted ${pull === 0 ? "transition-[height] duration-200" : ""}`}
        >
          <RefreshCw
            style={refreshing ? undefined : { transform: `rotate(${pull * 4}deg)` }}
            className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`}
          />
        </div>

        {hasNoHosts && !loading && hideOnboarding && (
          <div className="px-4 py-10 text-center text-dim text-[12.5px]">
            No computer paired yet.
          </div>
        )}

        {hasNoHosts && !loading && !hideOnboarding && (
          <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <h2 className="text-[18px] font-semibold text-fg tracking-tight mb-1.5">
              Welcome to Cmob
            </h2>
            <p className="text-[13px] text-muted max-w-sm leading-relaxed mb-5">
              Connect your Mac to monitor cmux workspaces and control Claude Code, Antigravity,
              Codex, and Kiro from anywhere.
            </p>
            {onPairHost && (
              <button
                type="button"
                onClick={onPairHost}
                className="inline-flex items-center gap-2 px-4 min-h-[38px] rounded-lg bg-fg hover:bg-accent-strong text-bg text-[13px] font-medium transition-colors cursor-pointer"
              >
                <QrCode className="w-3.5 h-3.5" />
                <span>Connect Your Computer</span>
              </button>
            )}
            <code className="mt-4 text-[11.5px] text-muted bg-surface border border-line px-2.5 py-1 rounded-md font-mono">
              $ cmob qr --tailscale
            </code>
          </div>
        )}

        {workspaces.length === 0 && (loading || isConnecting) && (
          <div
            role="status"
            aria-live="polite"
            className="px-6 py-12 flex flex-col items-center justify-center gap-2 text-center text-muted text-[12.5px]"
          >
            <Loader2 className="w-4 h-4 animate-spin text-dim" />
            <span>{isConnecting ? "Connecting…" : "Loading workspaces…"}</span>
          </div>
        )}

        {!hasNoHosts && workspaces.length === 0 && !loading && !isConnecting && (
          <div className="px-6 py-12 text-center text-muted text-[13px]">
            No active workspaces found in cmux.
          </div>
        )}

        {workspaces.length > 0 && (
          <div className="divide-y divide-line/70">
            {workspaces.map((ws) => {
              const status = ws.status.toLowerCase();
              const isRunning = status === "running";
              const isWaiting = status === "waiting";
              const isSelected = Boolean(selectedWorkspaceId && selectedWorkspaceId === ws.id);
              const surfaceCount = ws.surfaces.length;

              const rowColorStyle: React.CSSProperties | undefined = ws.color
                ? {
                    boxShadow: isSelected
                      ? `inset 3px 0 0 ${ws.color}, inset 0 0 0 1px rgba(255, 255, 255, 0.06)`
                      : `inset 3px 0 0 ${ws.color}`,
                    backgroundImage: isSelected
                      ? `linear-gradient(90deg, color-mix(in srgb, ${ws.color} 30%, transparent) 0%, color-mix(in srgb, ${ws.color} 11%, transparent) 52%, transparent 92%)`
                      : `linear-gradient(90deg, color-mix(in srgb, ${ws.color} 17%, transparent) 0%, color-mix(in srgb, ${ws.color} 5%, transparent) 46%, transparent 80%)`,
                  }
                : isSelected
                  ? {
                      boxShadow:
                        "inset 3px 0 0 var(--color-fg), inset 0 0 0 1px rgba(255, 255, 255, 0.06)",
                    }
                  : undefined;

              if (isSidebar) {
                return (
                  <Pressable
                    key={ws.id}
                    onPress={() => onSelectWorkspace(ws)}
                    aria-current={isSelected ? "true" : undefined}
                    style={rowColorStyle}
                    className={`flex flex-col px-3.5 py-2.5 cursor-pointer transition-colors group ${
                      isSelected
                        ? "bg-raised/60 text-fg"
                        : "text-fg-soft hover:bg-surface/70 active:bg-raised/60"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0 flex-1">
                        {ws.pinned && <Pin className="w-2.5 h-2.5 text-dim shrink-0" />}
                        <h2
                          className={`text-[13px] truncate leading-snug ${
                            isSelected ? "font-semibold text-fg" : "font-medium text-fg/92"
                          }`}
                        >
                          {ws.title}
                        </h2>
                        {isWaiting ? (
                          <span
                            className="w-1.5 h-1.5 rounded-full bg-status-wait shrink-0"
                            title="Waiting for input"
                          />
                        ) : isRunning ? (
                          <span
                            className="w-1.5 h-1.5 rounded-full bg-fg/85 animate-pulse shrink-0"
                            title="Running"
                          />
                        ) : null}
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <UnreadCountBadge count={ws.unread_count} size="sm" />
                        {surfaceCount > 0 && ws.unread_count === 0 && (
                          <span className="text-[11px] font-mono text-dim tabular-nums">
                            {surfaceCount}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="mt-0.5 min-w-0">
                      {ws.snippet ? (
                        <p className="text-[11.5px] text-muted truncate leading-snug">
                          {plainSnippet(ws.snippet)}
                        </p>
                      ) : (
                        <p
                          className="text-[11px] font-mono text-dim truncate leading-snug"
                          title={ws.current_directory}
                        >
                          {shortPath(ws.current_directory)}
                        </p>
                      )}
                    </div>
                  </Pressable>
                );
              }

              return (
                <Pressable
                  key={ws.id}
                  onPress={() => onSelectWorkspace(ws)}
                  aria-current={isSelected ? "true" : undefined}
                  style={rowColorStyle}
                  className={`flex items-center justify-between px-4 py-3 cursor-pointer transition-colors group ${
                    isSelected ? "bg-raised/60" : "hover:bg-surface/65 active:bg-raised/50"
                  }`}
                >
                  <div className="min-w-0 flex-1 pr-2 space-y-0.5">
                    <div className="flex items-center justify-between gap-2 min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0 flex-1">
                        {ws.pinned && <Pin className="w-3 h-3 text-dim shrink-0" />}
                        <h2 className="text-[14px] font-medium text-fg truncate leading-snug">
                          {ws.title}
                        </h2>
                        <UnreadCountBadge count={ws.unread_count} size="sm" />
                      </div>
                      {surfaceCount > 0 && (
                        <span className="text-[11px] font-mono text-dim shrink-0 tabular-nums">
                          {surfaceCount} {surfaceCount === 1 ? "tab" : "tabs"}
                        </span>
                      )}
                    </div>

                    {ws.snippet && (
                      <p className="text-[12.5px] text-muted line-clamp-1 leading-snug">
                        {plainSnippet(ws.snippet)}
                      </p>
                    )}

                    <div className="flex items-center gap-2 min-w-0 text-[11px] leading-none pt-0.5">
                      {isWaiting && (
                        <span className="inline-flex items-center gap-1 font-medium text-status-wait shrink-0">
                          <span className="w-1.5 h-1.5 rounded-full bg-status-wait" />
                          <span>Waiting</span>
                        </span>
                      )}
                      {isRunning && !isWaiting && (
                        <span className="inline-flex items-center gap-1 font-medium text-fg-soft shrink-0">
                          <span className="w-1.5 h-1.5 rounded-full bg-fg/85 animate-pulse" />
                          <span>Active</span>
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

                  <ChevronRight className="w-4 h-4 text-dim group-hover:text-muted transition-colors shrink-0" />
                </Pressable>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
