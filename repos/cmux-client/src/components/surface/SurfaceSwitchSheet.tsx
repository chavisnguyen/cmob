import { useEffect } from "react";
import { FileText, Globe, Plus, Terminal, X } from "lucide-react";
import type { SurfaceNode } from "../../protocol/rpc";
import { AgentIcon } from "../common/AgentIcon";
import { agentDisplayName } from "../common/agentBrand";
import { Pressable } from "../common/Pressable";
import { UnreadCountBadge } from "../common/UnreadCountBadge";
import { displaySurfaceTitle } from "./surfaceTitle";

interface SurfaceSwitchSheetProps {
  surfaces: SurfaceNode[];
  activeSurfaceId: string;
  onSelect: (surface: SurfaceNode) => void;
  onNew: () => void;
  onClose: () => void;
}

export function SurfaceSwitchSheet({
  surfaces,
  activeSurfaceId,
  onSelect,
  onNew,
  onClose,
}: SurfaceSwitchSheetProps) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center md:p-4 bg-black/65 backdrop-blur-[1px] animate-fade-in"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Switch tab"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl md:max-w-md mx-auto max-h-[70vh] flex flex-col rounded-t-xl md:rounded-xl bg-surface border-t md:border border-line-strong shadow-2xl pb-[env(safe-area-inset-bottom,0px)] md:pb-0 overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 h-11 bg-sidebar border-b border-line shrink-0">
          <h2 className="text-[13.5px] font-semibold text-fg">Tabs · {surfaces.length}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-7 h-7 rounded-md text-muted hover:text-fg hover:bg-raised flex items-center justify-center"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-y-auto py-1 divide-y divide-line/60 bg-bg">
          {surfaces.map((surf) => {
            const id = surf.id || surf.ref;
            const active = id === activeSurfaceId;
            const status = surf.agent?.status;
            return (
              <Pressable
                key={id}
                onPress={() => {
                  onSelect(surf);
                  onClose();
                }}
                className={`flex items-center gap-3 px-4 min-h-[48px] cursor-pointer transition-colors ${
                  active ? "bg-raised" : "hover:bg-surface/70 active:bg-surface"
                }`}
              >
                <div className="w-5 h-5 flex items-center justify-center shrink-0">
                  {surf.surface_type === "markdown" ? (
                    <FileText className="w-4 h-4 text-muted" />
                  ) : surf.surface_type === "browser" ? (
                    <Globe className="w-4 h-4 text-muted" />
                  ) : surf.agent ? (
                    <AgentIcon kind={surf.agent.agent_kind} size={16} />
                  ) : (
                    <Terminal className="w-4 h-4 text-dim" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <div className="text-[13.5px] font-medium text-fg truncate">
                      {displaySurfaceTitle(surf.title)}
                    </div>
                    <UnreadCountBadge count={surf.unread_count} size="sm" />
                  </div>
                  <div className="text-[11.5px] text-muted truncate">
                    {surf.agent
                      ? `${agentDisplayName(surf.agent.agent_kind)} · ${status}`
                      : surf.tty || "Terminal"}
                  </div>
                </div>
                {status === "running" && (
                  <span className="w-1.5 h-1.5 rounded-full bg-fg shrink-0" />
                )}
                {status === "waiting" && (
                  <span className="w-1.5 h-1.5 rounded-full bg-status-wait shrink-0" />
                )}
                {active && (
                  <span className="text-[11px] font-mono text-muted shrink-0">current</span>
                )}
              </Pressable>
            );
          })}
        </div>
        <div className="p-2.5 bg-sidebar border-t border-line">
          <button
            type="button"
            onClick={() => {
              onNew();
              onClose();
            }}
            className="w-full h-9 rounded-lg bg-fg hover:bg-accent-strong text-bg text-[13px] font-medium flex items-center justify-center gap-1.5 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Tab</span>
          </button>
        </div>
      </div>
    </div>
  );
}
