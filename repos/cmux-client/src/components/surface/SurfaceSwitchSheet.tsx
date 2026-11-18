import { Terminal, FileText, Globe, Plus, X } from "lucide-react";
import { AgentIcon } from "../common/AgentIcon";
import { Pressable } from "../common/Pressable";
import { agentDisplayName } from "../common/agentBrand";
import type { SurfaceNode } from "../../protocol/rpc";
import { displaySurfaceTitle } from "./surfaceTitle";

interface SurfaceSwitchSheetProps {
  surfaces: SurfaceNode[];
  activeSurfaceId: string;
  onSelect: (surface: SurfaceNode) => void;
  onNew: () => void;
  onClose: () => void;
}

/** Bottom sheet listing every tab of the workspace; replaces the always-visible chip strip. */
export function SurfaceSwitchSheet({
  surfaces,
  activeSurfaceId,
  onSelect,
  onNew,
  onClose,
}: SurfaceSwitchSheetProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-black/60 animate-fade-in"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Switch tab"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl mx-auto max-h-[70vh] flex flex-col rounded-t-2xl bg-bg border-t border-white/[0.1] shadow-2xl pb-[env(safe-area-inset-bottom,0px)]"
      >
        <div className="flex items-center justify-between px-4 h-12 border-b border-white/[0.08] shrink-0">
          <h2 className="text-[15px] font-semibold">Tabs · {surfaces.length}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-9 h-9 rounded-xl text-muted hover:bg-raised flex items-center justify-center"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-y-auto py-1">
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
                className={`flex items-center gap-3 px-4 min-h-[56px] cursor-pointer ${
                  active ? "bg-accent/12" : "active:bg-white/[0.05]"
                }`}
              >
                <div className="w-9 h-9 rounded-[10px] bg-surface border border-white/[0.07] flex items-center justify-center shrink-0">
                  {surf.surface_type === "markdown" ? (
                    <FileText className="w-4 h-4 text-[#86efac]" />
                  ) : surf.surface_type === "browser" ? (
                    <Globe className="w-4 h-4 text-accent-soft" />
                  ) : surf.agent ? (
                    <AgentIcon kind={surf.agent.agent_kind} size={18} />
                  ) : (
                    <Terminal className="w-4 h-4 text-muted" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[14.5px] font-medium truncate">
                    {displaySurfaceTitle(surf.title)}
                  </div>
                  <div className="text-[12.5px] text-muted truncate">
                    {surf.agent
                      ? `${agentDisplayName(surf.agent.agent_kind)} · ${status}`
                      : surf.tty || "Terminal"}
                  </div>
                </div>
                {status === "running" && (
                  <span className="w-2 h-2 rounded-full bg-accent shrink-0" />
                )}
                {status === "waiting" && (
                  <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
                )}
                {active && (
                  <span className="text-[12px] font-medium text-accent-soft shrink-0">Current</span>
                )}
              </Pressable>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => {
            onNew();
            onClose();
          }}
          className="mx-4 my-3 h-11 rounded-xl bg-raised hover:bg-line text-[14px] font-medium flex items-center justify-center gap-1.5"
        >
          <Plus className="w-4 h-4" />
          <span>New tab</span>
        </button>
      </div>
    </div>
  );
}
