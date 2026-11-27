import type { ReactNode } from "react";
import {
  FileText,
  GitBranch,
  Globe,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Terminal,
  X,
} from "lucide-react";
import type { SurfaceNode, WorkspaceNode } from "../../protocol/rpc";
import { AgentIcon } from "../common/AgentIcon";
import { UnreadCountBadge } from "../common/UnreadCountBadge";
import { displaySurfaceTitle } from "../surface/surfaceTitle";

export interface DesktopTabStripProps {
  workspace: WorkspaceNode | null;
  sectionTitle?: string;
  surfaces: SurfaceNode[];
  activeSurface: SurfaceNode | null;
  sidebarCollapsed: boolean;
  loading?: boolean;
  onToggleSidebar: () => void;
  onSelectSurface: (surface: SurfaceNode) => void;
  onNewSurface: () => void;
  onCloseSurface: (surface: SurfaceNode) => void;
  onOpenChanges: () => void;
  onRefresh: () => void;
  extraControls?: ReactNode;
  usageWidget?: ReactNode;
}

/**
 * Single 38px macOS toolbar merging sidebar toggle, native tab strip, Chat/Term switch,
 * Git changes, and provider quota into one crisp horizontal chrome bar.
 */
export function DesktopTabStrip({
  workspace,
  sectionTitle,
  surfaces,
  activeSurface,
  sidebarCollapsed,
  loading = false,
  onToggleSidebar,
  onSelectSurface,
  onNewSurface,
  onCloseSurface,
  onOpenChanges,
  onRefresh,
  extraControls,
  usageWidget,
}: DesktopTabStripProps) {
  const activeKey = activeSurface?.id || activeSurface?.ref || "";

  return (
    <header className="flex items-stretch justify-between h-[38px] bg-[#10100f] shadow-[inset_0_-1px_0_var(--color-line)] shrink-0 select-none">
      <div className="flex items-stretch min-w-0 flex-1">
        <button
          type="button"
          onClick={onToggleSidebar}
          className="w-[38px] h-full border-r border-b border-line hover:bg-[#1a1a18] text-muted hover:text-fg flex items-center justify-center shrink-0 transition-colors"
          title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
          aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        >
          {sidebarCollapsed ? (
            <PanelLeftOpen className="w-3.5 h-3.5" />
          ) : (
            <PanelLeftClose className="w-3.5 h-3.5" />
          )}
        </button>

        {sectionTitle ? (
          <div className="flex items-center px-3.5 border-b border-line min-w-0 flex-1">
            <span className="text-[13px] font-medium text-fg truncate">{sectionTitle}</span>
          </div>
        ) : workspace ? (
          <div className="flex items-stretch min-w-0 flex-1 overflow-x-auto no-scrollbar">
            {surfaces.map((surf) => {
              const key = surf.id || surf.ref;
              const isActive = key === activeKey;
              const status = surf.agent?.status.toLowerCase();

              return (
                <div
                  key={key}
                  className={`relative group flex items-center gap-1.5 h-full pl-3 pr-1.5 border-r border-line text-[12.5px] shrink-0 min-w-[132px] max-w-[230px] transition-colors ${
                    isActive
                      ? "bg-bg text-fg font-medium before:content-[''] before:absolute before:inset-x-0 before:top-0 before:h-[2px] before:bg-accent"
                      : "bg-[#161615] border-b border-b-line text-fg-soft/75 hover:bg-[#1d1d1b] hover:text-fg"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectSurface(surf)}
                    className="flex items-center gap-1.5 min-w-0 flex-1 h-full text-left"
                  >
                    <span
                      className={`shrink-0 flex items-center ${
                        isActive ? "opacity-100" : "opacity-80 group-hover:opacity-100"
                      }`}
                    >
                      {surf.surface_type === "markdown" ? (
                        <FileText className="w-3.5 h-3.5 text-status-wait/85" />
                      ) : surf.surface_type === "browser" ? (
                        <Globe className="w-3.5 h-3.5 text-accent/85" />
                      ) : surf.agent ? (
                        <AgentIcon kind={surf.agent.agent_kind} size={13} />
                      ) : (
                        <Terminal
                          className={`w-3.5 h-3.5 ${isActive ? "text-status-ok/90" : "text-muted"}`}
                        />
                      )}
                    </span>
                    <UnreadCountBadge count={surf.unread_count} size="sm" />
                    <span className="truncate">{displaySurfaceTitle(surf.title)}</span>
                    {status === "running" && (
                      <span className="w-1.5 h-1.5 rounded-full bg-status-run animate-pulse shrink-0" />
                    )}
                    {status === "waiting" && (
                      <span className="w-1.5 h-1.5 rounded-full bg-status-wait shrink-0" />
                    )}
                    {status === "error" && (
                      <span className="w-1.5 h-1.5 rounded-full bg-status-err shrink-0" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseSurface(surf);
                    }}
                    className={`w-[18px] h-[18px] rounded-[4px] hover:bg-raised text-muted hover:text-fg flex items-center justify-center shrink-0 transition-opacity ${
                      isActive
                        ? "opacity-75 hover:opacity-100"
                        : "opacity-0 group-hover:opacity-100"
                    }`}
                    title={`Close ${displaySurfaceTitle(surf.title)}`}
                    aria-label={`Close ${displaySurfaceTitle(surf.title)}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );
            })}

            <button
              type="button"
              onClick={onNewSurface}
              className="h-full w-[34px] border-r border-b border-line/70 hover:bg-[#1d1d1b] text-muted hover:text-fg flex items-center justify-center shrink-0 transition-colors"
              title="New tab"
              aria-label="New tab"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-1 px-2.5 h-full border-b border-line shrink-0">
        {extraControls}
        {extraControls && (workspace || usageWidget) && (
          <div className="h-3.5 w-px bg-line mx-0.5" aria-hidden="true" />
        )}
        {usageWidget}
        {workspace && (
          <>
            <button
              type="button"
              onClick={onOpenChanges}
              className="h-[26px] px-2 rounded-[6px] hover:bg-raised text-muted hover:text-fg text-[11.5px] font-medium inline-flex items-center gap-1.5 transition-colors"
              title="Git working tree changes"
            >
              <GitBranch className="w-3.5 h-3.5 text-status-ok/85" />
              <span>Changes</span>
            </button>

            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="w-[26px] h-[26px] rounded-[6px] hover:bg-raised text-muted hover:text-fg flex items-center justify-center transition-colors disabled:opacity-40"
              title="Refresh workspace"
              aria-label="Refresh workspace"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
          </>
        )}
      </div>
    </header>
  );
}
