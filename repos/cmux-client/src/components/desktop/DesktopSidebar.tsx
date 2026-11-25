import { useEffect, useState } from "react";
import {
  Bell,
  BellRing,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderGit2,
  Gauge,
  GitBranch,
  Globe,
  KeyRound,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  Server,
  Terminal,
  X,
} from "lucide-react";
import type { SavedHost } from "../../hosts/hostStore";
import type { SurfaceNode, WorkspaceNode } from "../../protocol/rpc";
import type { ConnectionState } from "../../transport/wsClient";
import { isDemoMode } from "../../demo/demoData";
import { AgentIcon } from "../common/AgentIcon";
import { shortPath } from "../chat/textUtils";
import { displaySurfaceTitle } from "../surface/surfaceTitle";

interface DesktopSidebarProps {
  hostsCount: number;
  activeHost: SavedHost | null | undefined;
  connState: ConnectionState;
  workspaces: WorkspaceNode[];
  selectedWorkspace: WorkspaceNode | null;
  selectedSurface: SurfaceNode | null;
  mainTab: "workspaces" | "usage" | "devices";
  loading: boolean;
  notifPermission: NotificationPermission;
  onOpenHostSwitcher: () => void;
  onToggleNotifications: () => void;
  onOpenPair: () => void;
  onOpenUsage: () => void;
  onOpenDevices: () => void;
  onOpenToken: () => void;
  onForceReload: () => void;
  onRefresh: () => void;
  onSelectWorkspace: (ws: WorkspaceNode) => void;
  onSelectSurface: (ws: WorkspaceNode, surf: SurfaceNode) => void;
  onNewSurface: (ws: WorkspaceNode) => void;
  onRenameSurface: (ws: WorkspaceNode, surf: SurfaceNode) => void;
  onCloseSurface: (ws: WorkspaceNode, surf: SurfaceNode) => void;
  onOpenChanges: (ws: WorkspaceNode) => void;
}

export function DesktopSidebar({
  hostsCount,
  activeHost,
  connState,
  workspaces,
  selectedWorkspace,
  selectedSurface,
  mainTab,
  loading,
  notifPermission,
  onOpenHostSwitcher,
  onToggleNotifications,
  onOpenPair,
  onOpenUsage,
  onOpenDevices,
  onOpenToken,
  onForceReload,
  onRefresh,
  onSelectWorkspace,
  onSelectSurface,
  onNewSurface,
  onRenameSurface,
  onCloseSurface,
  onOpenChanges,
}: DesktopSidebarProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!selectedWorkspace) return;
    setExpandedIds((prev) => {
      if (prev.has(selectedWorkspace.id)) return prev;
      const next = new Set(prev);
      next.add(selectedWorkspace.id);
      return next;
    });
  }, [selectedWorkspace]);

  const toggleExpanded = (wsId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(wsId)) next.delete(wsId);
      else next.add(wsId);
      return next;
    });
  };

  const activeSurfaceKey = selectedSurface?.id || selectedSurface?.ref || "";

  return (
    <aside
      aria-label="Workspaces sidebar"
      className="w-72 xl:w-80 shrink-0 h-full flex flex-col bg-surface border-r border-line select-none"
    >
      {/* Top Brand & Global Actions */}
      <div className="relative flex items-center justify-between px-3 h-12 border-b border-line shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[16px] font-bold tracking-tight text-fg">Cmob</span>
          {isDemoMode() && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10.5px] font-semibold bg-accent/20 text-accent-soft border border-accent/30">
              Demo
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading || hostsCount === 0}
            className="w-8 h-8 rounded-lg hover:bg-raised text-muted hover:text-fg flex items-center justify-center transition-colors disabled:opacity-40"
            title="Refresh workspaces"
            aria-label="Refresh workspaces"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>

          <button
            type="button"
            onClick={onToggleNotifications}
            className={`w-8 h-8 rounded-lg hover:bg-raised flex items-center justify-center transition-colors ${
              notifPermission === "granted"
                ? "text-emerald-400"
                : notifPermission === "denied"
                  ? "text-dim cursor-not-allowed"
                  : "text-amber-300"
            }`}
            title={`Notifications: ${notifPermission}`}
            aria-label="Notifications"
          >
            {notifPermission === "granted" ? (
              <BellRing className="w-4 h-4" />
            ) : (
              <Bell className="w-4 h-4" />
            )}
          </button>

          <button
            type="button"
            onClick={() => setShowMenu((v) => !v)}
            className="w-8 h-8 rounded-lg hover:bg-raised text-muted hover:text-fg flex items-center justify-center transition-colors"
            title="Menu"
            aria-label="Menu"
            aria-expanded={showMenu}
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>
        </div>

        {showMenu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
            <div className="absolute right-2 top-[calc(100%+4px)] z-50 w-52 rounded-xl bg-surface border border-white/[0.12] shadow-2xl py-1 overflow-hidden">
              {[
                { label: "Pair new computer", icon: Plus, run: onOpenPair },
                { label: "Hosts & devices", icon: Server, run: onOpenDevices },
                { label: "Auth token", icon: KeyRound, run: onOpenToken },
                { label: "Reload app", icon: RefreshCw, run: onForceReload },
              ].map(({ label, icon: Icon, run }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => {
                    setShowMenu(false);
                    run();
                  }}
                  className="w-full h-9 px-3 flex items-center gap-2.5 text-[13px] font-medium text-fg hover:bg-white/[0.06] transition-colors"
                >
                  <Icon className="w-3.5 h-3.5 text-muted" />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Active Computer Switcher */}
      <div className="px-2.5 py-2 border-b border-line shrink-0">
        <button
          type="button"
          onClick={onOpenHostSwitcher}
          aria-label={`Switch computer (${connState})`}
          className="w-full flex items-center justify-between gap-2 px-2.5 h-9 rounded-xl bg-raised/70 hover:bg-raised border border-white/[0.06] text-[12.5px] font-medium text-fg-soft transition-colors"
        >
          <span className="flex items-center gap-2 min-w-0">
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                connState === "connected"
                  ? "bg-emerald-400"
                  : connState === "connecting" || connState === "authenticating"
                    ? "bg-amber-400 animate-pulse"
                    : "bg-rose-400"
              }`}
            />
            <span className="truncate">{activeHost?.name ?? "No computer"}</span>
          </span>
          <ChevronDown className="w-3.5 h-3.5 text-muted shrink-0" />
        </button>
      </div>

      {/* Workspaces & Nested Surfaces Tree */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1 scrollbar-sleek">
        <div className="px-2 pb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-dim">
          <span>Workspaces</span>
          <span className="font-mono">{workspaces.length}</span>
        </div>

        {workspaces.length === 0 && !loading && (
          <div className="px-3 py-6 text-center text-[12.5px] text-muted">
            {hostsCount === 0 ? "No computer paired yet." : "No active workspaces."}
          </div>
        )}

        {workspaces.map((ws) => {
          const isWsSelected = mainTab === "workspaces" && selectedWorkspace?.id === ws.id;
          const isExpanded = expandedIds.has(ws.id) || isWsSelected;
          const isRunning = ws.status.toLowerCase() === "running";

          return (
            <div key={ws.id} className="space-y-0.5">
              <div
                style={
                  ws.color
                    ? {
                        boxShadow: `inset 3px 0 0 ${ws.color}`,
                      }
                    : undefined
                }
                className={`group flex items-center gap-1.5 rounded-xl px-2 py-1.5 transition-colors ${
                  isWsSelected
                    ? "bg-raised text-fg"
                    : "text-fg-soft hover:bg-white/[0.04] hover:text-fg"
                }`}
              >
                <button
                  type="button"
                  onClick={() => toggleExpanded(ws.id)}
                  aria-label={isExpanded ? `Collapse ${ws.title}` : `Expand ${ws.title}`}
                  className="w-5 h-5 rounded flex items-center justify-center text-dim hover:text-fg shrink-0"
                >
                  {isExpanded ? (
                    <ChevronDown className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => onSelectWorkspace(ws)}
                  className="flex items-center gap-2 min-w-0 flex-1 text-left"
                >
                  <FolderGit2
                    className="w-4 h-4 shrink-0 text-muted"
                    style={ws.color ? { color: ws.color } : undefined}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[13px] font-semibold truncate">{ws.title}</span>
                      {ws.pinned && <Pin className="w-3 h-3 text-dim shrink-0" />}
                    </div>
                    {ws.current_directory && (
                      <div className="text-[11px] text-dim font-mono truncate">
                        {shortPath(ws.current_directory, 2)}
                      </div>
                    )}
                  </div>
                </button>

                <div className="flex items-center gap-1 shrink-0">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${isRunning ? "bg-accent" : "bg-dim/60"}`}
                    title={isRunning ? "Running" : "Idle"}
                  />
                  <button
                    type="button"
                    onClick={() => onOpenChanges(ws)}
                    className="w-6 h-6 rounded-md opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-white/[0.08] text-muted hover:text-fg flex items-center justify-center transition-opacity"
                    title="Git changes"
                    aria-label={`Git changes in ${ws.title}`}
                  >
                    <GitBranch className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onNewSurface(ws)}
                    className="w-6 h-6 rounded-md opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-white/[0.08] text-muted hover:text-fg flex items-center justify-center transition-opacity"
                    title="New tab"
                    aria-label={`New tab in ${ws.title}`}
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {isExpanded && (
                <div className="ml-4 pl-2 border-l border-white/[0.07] space-y-0.5 py-0.5">
                  {ws.surfaces.length === 0 ? (
                    <button
                      type="button"
                      onClick={() => onNewSurface(ws)}
                      className="w-full px-2 py-1.5 rounded-lg text-[12px] text-dim hover:text-fg hover:bg-white/[0.04] flex items-center gap-1.5 text-left"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Open first tab</span>
                    </button>
                  ) : (
                    ws.surfaces.map((surf) => {
                      const surfKey = surf.id || surf.ref;
                      const isActive = isWsSelected && surfKey === activeSurfaceKey;
                      const agentStatus = surf.agent?.status.toLowerCase();

                      return (
                        <div
                          key={surfKey}
                          className={`group/tab flex items-center gap-1.5 rounded-lg px-2 py-1.5 transition-colors ${
                            isActive
                              ? "bg-accent/15 text-fg border border-accent/30"
                              : "text-muted hover:bg-white/[0.04] hover:text-fg border border-transparent"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => onSelectSurface(ws, surf)}
                            className="flex items-center gap-2 min-w-0 flex-1 text-left"
                          >
                            <span className="w-4 h-4 flex items-center justify-center shrink-0">
                              {surf.surface_type === "markdown" ? (
                                <FileText className="w-3.5 h-3.5 text-[#86efac]" />
                              ) : surf.surface_type === "browser" ? (
                                <Globe className="w-3.5 h-3.5 text-accent-soft" />
                              ) : surf.agent ? (
                                <AgentIcon kind={surf.agent.agent_kind} size={14} />
                              ) : (
                                <Terminal className="w-3.5 h-3.5 text-muted" />
                              )}
                            </span>
                            <span className="text-[12.5px] font-medium truncate">
                              {displaySurfaceTitle(surf.title)}
                            </span>
                          </button>

                          {agentStatus === "running" && (
                            <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                          )}
                          {agentStatus === "waiting" && (
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                          )}
                          {agentStatus === "error" && (
                            <span className="w-1.5 h-1.5 rounded-full bg-rose-400 shrink-0" />
                          )}

                          <div className="hidden group-hover/tab:flex items-center gap-0.5 shrink-0">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onRenameSurface(ws, surf);
                              }}
                              className="w-5 h-5 rounded hover:bg-white/[0.1] text-muted hover:text-fg flex items-center justify-center"
                              title="Rename tab"
                              aria-label={`Rename ${surf.title}`}
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onCloseSurface(ws, surf);
                              }}
                              className="w-5 h-5 rounded hover:bg-rose-500/20 text-muted hover:text-rose-300 flex items-center justify-center"
                              title="Close tab"
                              aria-label={`Close ${surf.title}`}
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Bottom Usage & Devices Navigation */}
      <div className="p-2 border-t border-line shrink-0 space-y-1">
        <button
          type="button"
          onClick={onOpenUsage}
          className={`w-full h-9 px-2.5 rounded-xl flex items-center justify-between text-[12.5px] font-medium transition-colors ${
            mainTab === "usage"
              ? "bg-raised text-fg"
              : "text-muted hover:bg-white/[0.04] hover:text-fg"
          }`}
        >
          <span className="flex items-center gap-2">
            <Gauge className="w-3.5 h-3.5" />
            <span>Model Usage</span>
          </span>
        </button>

        <button
          type="button"
          onClick={onOpenDevices}
          className={`w-full h-9 px-2.5 rounded-xl flex items-center justify-between text-[12.5px] font-medium transition-colors ${
            mainTab === "devices"
              ? "bg-raised text-fg"
              : "text-muted hover:bg-white/[0.04] hover:text-fg"
          }`}
        >
          <span className="flex items-center gap-2">
            <Server className="w-3.5 h-3.5" />
            <span>Devices &amp; Hosts</span>
          </span>
          <span className="text-[11px] font-mono text-dim">{hostsCount}</span>
        </button>
      </div>
    </aside>
  );
}
