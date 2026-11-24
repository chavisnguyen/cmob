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
import { displaySurfaceTitle } from "../surface/surfaceTitle";

interface DesktopTabStripProps {
  workspace: WorkspaceNode | null;
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
}

export function DesktopTabStrip({
  workspace,
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
}: DesktopTabStripProps) {
  const activeKey = activeSurface?.id || activeSurface?.ref || "";

  return (
    <div className="flex items-center justify-between gap-2 h-11 px-2.5 bg-surface border-b border-line shrink-0 select-none">
      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        <button
          type="button"
          onClick={onToggleSidebar}
          className="w-8 h-8 rounded-lg hover:bg-raised text-muted hover:text-fg flex items-center justify-center shrink-0 transition-colors"
          title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
          aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        >
          {sidebarCollapsed ? (
            <PanelLeftOpen className="w-4 h-4" />
          ) : (
            <PanelLeftClose className="w-4 h-4" />
          )}
        </button>

        {workspace && (
          <div className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto no-scrollbar py-1">
            {surfaces.map((surf) => {
              const key = surf.id || surf.ref;
              const isActive = key === activeKey;
              const status = surf.agent?.status.toLowerCase();

              return (
                <div
                  key={key}
                  className={`group flex items-center gap-1.5 h-8 pl-2.5 pr-1.5 rounded-lg border text-[12.5px] font-medium shrink-0 max-w-[210px] transition-colors ${
                    isActive
                      ? "bg-bg border-line text-fg shadow-xs"
                      : "bg-transparent border-transparent text-muted hover:bg-white/[0.04] hover:text-fg-soft"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectSurface(surf)}
                    className="flex items-center gap-1.5 min-w-0 flex-1 text-left"
                  >
                    <span className="shrink-0 flex items-center">
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
                    <span className="truncate">{displaySurfaceTitle(surf.title)}</span>
                    {status === "running" && (
                      <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                    )}
                    {status === "waiting" && (
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                    )}
                    {status === "error" && (
                      <span className="w-1.5 h-1.5 rounded-full bg-rose-400 shrink-0" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseSurface(surf);
                    }}
                    className="w-5 h-5 rounded opacity-60 group-hover:opacity-100 hover:bg-white/[0.08] text-muted hover:text-rose-300 flex items-center justify-center shrink-0 transition-opacity"
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
              className="h-8 w-8 rounded-lg hover:bg-raised text-muted hover:text-fg flex items-center justify-center shrink-0 transition-colors"
              title="New tab"
              aria-label="New tab"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {workspace && (
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onOpenChanges}
            className="h-8 px-2.5 rounded-lg bg-raised hover:bg-line text-fg-soft text-[12px] font-medium inline-flex items-center gap-1.5 transition-colors"
            title="Git changes"
          >
            <GitBranch className="w-3.5 h-3.5" />
            <span>Changes</span>
          </button>

          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="w-8 h-8 rounded-lg hover:bg-raised text-muted hover:text-fg flex items-center justify-center transition-colors disabled:opacity-40"
            title="Refresh workspace"
            aria-label="Refresh workspace"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      )}
    </div>
  );
}
