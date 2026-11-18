import { useEffect, useRef, useState } from "react";
import { Pin, RefreshCw, Terminal, ChevronRight, FolderGit2, QrCode } from "lucide-react";
import type { WorkspaceNode } from "../protocol/rpc";
import type { ConnectionState } from "../transport/wsClient";
import { Pressable } from "../components/common/Pressable";
import { plainSnippet, shortPath } from "../components/chat/textUtils";

interface WorkspaceListViewProps {
  workspaces: WorkspaceNode[];
  loading: boolean;
  onRefresh: () => void;
  onSelectWorkspace: (workspace: WorkspaceNode) => void;
  hostsCount?: number;
  connState?: ConnectionState;
  onPairHost?: () => void;
}

export function WorkspaceListView({
  workspaces,
  loading,
  onRefresh,
  onSelectWorkspace,
  hostsCount,
  connState,
  onPairHost,
}: WorkspaceListViewProps) {
  // Pull to refresh: a drag down from the top of the list. The page itself never scrolls (fixed body),
  // so the browser's native gesture does not exist here.
  const PULL_TRIGGER = 64;
  const [pull, setPull] = useState(0);
  // Only a pull shows the spinner row: the app polls every few seconds and `loading` flips each time.
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
    <div className="flex flex-col h-full w-full max-w-3xl mx-auto bg-bg text-fg">
      <header className="flex items-center justify-between px-4 min-h-[52px] bg-surface border-b border-line w-full shrink-0">
        <div className="flex items-center gap-2.5">
          <h1 className="text-[16px] font-semibold tracking-tight text-fg">Workspaces</h1>
          <span className="inline-flex items-center justify-center min-w-[24px] h-6 px-2 rounded-full bg-raised text-[12px] font-medium text-muted font-mono">
            {workspaces.length}
          </span>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading || hasNoHosts}
          className="w-9 h-9 rounded-xl bg-raised hover:bg-line active:opacity-75 text-fg-soft flex items-center justify-center transition-colors disabled:opacity-40"
          title="Refresh workspaces"
          aria-label="Refresh workspaces"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </header>

      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        className="flex-1 overflow-y-auto overscroll-contain divide-y divide-white/[0.06] pb-[env(safe-area-inset-bottom,0px)]"
      >
        <div
          aria-hidden="true"
          style={{ height: refreshing ? 36 : pull }}
          className={`flex items-center justify-center overflow-hidden text-muted ${pull === 0 ? "transition-[height] duration-200" : ""}`}
        >
          <RefreshCw
            style={refreshing ? undefined : { transform: `rotate(${pull * 4}deg)` }}
            className={`w-4 h-4 ${refreshing ? "animate-spin" : ""} ${pull >= PULL_TRIGGER ? "text-accent-soft" : ""}`}
          />
        </div>

        {hasNoHosts && !loading && (
          <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <h2 className="text-[20px] font-bold text-white tracking-tight mb-2">
              Welcome to Cmob
            </h2>
            <p className="text-[14px] text-muted max-w-sm leading-relaxed mb-6">
              Connect your computer to monitor terminal workspaces and control coding agents like
              Claude Code, AGY, and Kiro from your phone.
            </p>
            {onPairHost && (
              <button
                type="button"
                onClick={onPairHost}
                className="inline-flex items-center gap-2 px-5 min-h-[44px] rounded-xl bg-accent hover:bg-accent-strong text-white text-[14px] font-semibold transition-colors cursor-pointer"
              >
                <QrCode className="w-4 h-4" />
                <span>Connect Your Computer</span>
              </button>
            )}
            <code className="mt-5 text-[12.5px] text-emerald-400">$ cmob qr --tailscale</code>
          </div>
        )}

        {!hasNoHosts && workspaces.length === 0 && !loading && (
          <div className="px-6 py-12 text-center text-muted text-[14px]">
            No active workspaces found in cmux.
          </div>
        )}

        {workspaces.map((ws) => {
          const isRunning = ws.status.toLowerCase() === "running";
          const surfaceCount = ws.surfaces.length;

          return (
            <Pressable
              key={ws.id}
              onPress={() => onSelectWorkspace(ws)}
              style={
                ws.color
                  ? {
                      boxShadow: `inset 4px 0 0 ${ws.color}`,
                      backgroundImage: `linear-gradient(90deg, ${ws.color}26, transparent 70%)`,
                    }
                  : undefined
              }
              className="flex items-center justify-between px-4 py-3.5 min-h-[68px] hover:bg-bg active:bg-surface cursor-pointer transition-colors group"
            >
              <div className="flex items-start gap-3 min-w-0 flex-1 pr-3">
                <div
                  style={ws.color ? { backgroundColor: ws.color } : undefined}
                  className="w-10 h-10 rounded-[11px] bg-surface border border-white/[0.07] flex items-center justify-center text-muted shrink-0 mt-0.5"
                >
                  <FolderGit2 className={`w-5 h-5 ${ws.color ? "text-white" : "text-fg-soft"}`} />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-[15px] font-semibold text-fg truncate">{ws.title}</h2>
                    {ws.pinned && <Pin className="w-3.5 h-3.5 text-muted shrink-0" />}
                    <span
                      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[12px] font-medium shrink-0 ${
                        isRunning ? "bg-accent/15 text-accent-soft" : "bg-white/[0.06] text-muted"
                      }`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${isRunning ? "bg-accent" : "bg-dim"}`}
                      />
                      {isRunning ? "Running" : "Idle"}
                    </span>
                  </div>

                  {ws.snippet && (
                    <p className="mt-1 text-[13px] text-muted line-clamp-1 leading-snug">
                      {plainSnippet(ws.snippet)}
                    </p>
                  )}

                  <div className="mt-1.5 flex items-center gap-3 text-[12px] text-dim font-mono">
                    <span
                      className="truncate max-w-[210px] sm:max-w-md"
                      title={ws.current_directory}
                    >
                      {shortPath(ws.current_directory)}
                    </span>
                    <span className="flex items-center gap-1 shrink-0 text-muted">
                      <Terminal className="w-3.5 h-3.5" />
                      {surfaceCount} {surfaceCount === 1 ? "tab" : "tabs"}
                    </span>
                  </div>
                </div>
              </div>

              <ChevronRight className="w-5 h-5 text-dim group-hover:text-muted transition-colors shrink-0" />
            </Pressable>
          );
        })}
      </div>
    </div>
  );
}
