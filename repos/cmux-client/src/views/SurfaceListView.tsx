import { useState } from "react";
import type { CreateSurfaceParams } from "../components/surface/NewSurfaceModal";
import {
  ChevronLeft,
  Terminal,
  FileText,
  Globe,
  GitBranch,
  ChevronRight,
  Hash,
  MoreVertical,
  Pencil,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import type { SurfaceNode, WorkspaceNode } from "../protocol/rpc";
import { NewSurfaceModal } from "../components/surface/NewSurfaceModal";
import { RenameSurfaceModal } from "../components/surface/RenameSurfaceModal";
import { CloseSurfaceDialog } from "../components/surface/CloseSurfaceDialog";
import { Pressable } from "../components/common/Pressable";
import { ChangesPanel } from "../components/git/ChangesPanel";
import { AgentIcon } from "../components/common/AgentIcon";
import { agentDisplayName } from "../components/common/agentBrand";
import { displaySurfaceTitle } from "../components/surface/surfaceTitle";
import { shortPath } from "../components/chat/textUtils";

interface SurfaceListViewProps {
  workspace: WorkspaceNode;
  onBack: () => void;
  onSelectSurface: (surface: SurfaceNode) => void;
  onCreateSurface?: (params: CreateSurfaceParams) => Promise<void>;
  onRenameSurface?: (surfaceId: string, title: string) => Promise<void>;
  onCloseSurface?: (surfaceId: string) => Promise<void>;
  onRefresh?: () => void;
}

export function SurfaceListView({
  workspace,
  onBack,
  onSelectSurface,
  onCreateSurface,
  onRenameSurface,
  onCloseSurface,
  onRefresh,
}: SurfaceListViewProps) {
  const [showNewModal, setShowNewModal] = useState(false);
  const [showChanges, setShowChanges] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [surfaceToRename, setSurfaceToRename] = useState<SurfaceNode | null>(null);
  const [surfaceToClose, setSurfaceToClose] = useState<SurfaceNode | null>(null);

  const handleConfirmRename = async (nextTitle: string) => {
    if (!surfaceToRename || !onRenameSurface) return;
    const id = surfaceToRename.id || surfaceToRename.ref;
    await onRenameSurface(id, nextTitle);
    setSurfaceToRename(null);
  };

  const handleConfirmClose = async () => {
    if (!surfaceToClose || !onCloseSurface) return;
    const id = surfaceToClose.id || surfaceToClose.ref;
    await onCloseSurface(id);
    setSurfaceToClose(null);
  };

  return (
    <div className="flex flex-col h-full w-full max-w-3xl mx-auto bg-[#0a0a0a] text-[#fafafa]">
      <header className="flex items-center justify-between gap-2 px-3 min-h-[56px] bg-[#141416] border-b border-white/[0.08] w-full shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <button
            type="button"
            onClick={onBack}
            className="w-10 h-10 rounded-xl hover:bg-[#242428] active:opacity-75 text-[#fafafa] flex items-center justify-center transition-colors shrink-0"
            title="Back to Workspaces"
            aria-label="Back to Workspaces"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>

          <div className="min-w-0 flex-1">
            <h1 className="text-[16px] font-semibold text-[#fafafa] truncate leading-tight">
              {workspace.title}
            </h1>
            <p className="text-[12px] text-[#898989] font-mono truncate mt-0.5">
              {shortPath(workspace.current_directory, 3)}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              className="w-9 h-9 rounded-xl bg-[#242428] hover:bg-[#2e2e34] active:opacity-75 text-[#e5e5e5] flex items-center justify-center transition-colors"
              title="Refresh tabs"
              aria-label="Refresh tabs"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowChanges(true)}
            className="w-9 h-9 rounded-xl bg-[#242428] hover:bg-[#2e2e34] text-[#e5e5e5] flex items-center justify-center transition-colors"
            title="Git changes"
            aria-label="Git changes"
          >
            <GitBranch className="w-4 h-4" />
          </button>
          {onCreateSurface && (
            <button
              type="button"
              onClick={() => setShowNewModal(true)}
              className="h-9 px-3.5 rounded-xl bg-[#3276f2] hover:bg-[#2563eb] active:opacity-80 text-white text-[13px] font-semibold inline-flex items-center gap-1.5 transition-colors shadow-sm"
              title="New Tab"
            >
              <Plus className="w-4 h-4" />
              <span>Tab</span>
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto divide-y divide-white/[0.06]">
        {workspace.surfaces.length === 0 ? (
          <div className="p-10 text-center text-[#898989] text-[14px] flex flex-col items-center justify-center gap-4">
            <p>No terminal tabs open in this workspace.</p>
            {onCreateSurface && (
              <button
                type="button"
                onClick={() => setShowNewModal(true)}
                className="h-10 px-4 rounded-xl bg-[#3276f2] hover:bg-[#2563eb] text-white text-[14px] font-semibold inline-flex items-center gap-2 transition-colors"
              >
                <Plus className="w-4 h-4" />
                <span>Open First Tab</span>
              </button>
            )}
          </div>
        ) : (
          workspace.surfaces.map((surf) => {
            const hasAgent = Boolean(surf.agent);
            const agentStatus = surf.agent?.status.toLowerCase();

            return (
              <Pressable
                key={surf.id || surf.ref}
                onPress={() => onSelectSurface(surf)}
                className="flex items-center justify-between px-4 py-3.5 min-h-[66px] hover:bg-[#141416] active:bg-[#1c1c20] cursor-pointer transition-colors group"
              >
                <div className="flex items-center gap-3 min-w-0 flex-1 pr-2">
                  <div className="w-10 h-10 rounded-[11px] bg-[#1c1c20] border border-white/[0.07] flex items-center justify-center text-[#e5e5e5] shrink-0">
                    {surf.surface_type === "markdown" ? (
                      <FileText className="w-5 h-5 text-[#86efac]" />
                    ) : surf.surface_type === "browser" ? (
                      <Globe className="w-5 h-5 text-[#8ab4f8]" />
                    ) : hasAgent ? (
                      <AgentIcon kind={surf.agent?.agent_kind} size={22} />
                    ) : (
                      <Terminal className="w-5 h-5 text-[#e5e5e5]" />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="text-[15px] font-semibold text-[#fafafa] truncate">
                        {displaySurfaceTitle(surf.title)}
                      </h2>
                      {surf.selected && (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#3276f2]/15 text-[#8ab4f8] shrink-0">
                          Active
                        </span>
                      )}
                    </div>

                    <div className="mt-1 flex flex-wrap items-center gap-2.5 text-[12px]">
                      {surf.tty && (
                        <span className="text-[#898989] font-mono inline-flex items-center gap-0.5">
                          <Hash className="w-3 h-3" />
                          {surf.tty}
                        </span>
                      )}

                      {hasAgent && (
                        <span
                          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full font-medium ${
                            agentStatus === "running"
                              ? "bg-[#3276f2]/15 text-[#8ab4f8]"
                              : agentStatus === "waiting"
                                ? "bg-amber-500/15 text-amber-300"
                                : agentStatus === "error"
                                  ? "bg-rose-500/15 text-rose-300"
                                  : "bg-white/[0.06] text-[#a3a3a3]"
                          }`}
                        >
                          <span>{agentDisplayName(surf.agent?.agent_kind)}</span>
                          <span className="opacity-75">· {surf.agent?.status}</span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0 relative">
                  {(onRenameSurface || onCloseSurface) && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setMenuFor((cur) =>
                          cur === (surf.id || surf.ref) ? null : surf.id || surf.ref,
                        );
                      }}
                      className="w-10 h-10 rounded-xl text-[#a3a3a3] hover:text-[#fafafa] hover:bg-[#242428] flex items-center justify-center transition-colors"
                      title="Tab actions"
                      aria-label="Tab actions"
                      aria-expanded={menuFor === (surf.id || surf.ref)}
                    >
                      <MoreVertical className="w-4 h-4" />
                    </button>
                  )}
                  <ChevronRight className="w-5 h-5 text-[#525252]" />
                  {menuFor === (surf.id || surf.ref) && (
                    <>
                      <div
                        className="fixed inset-0 z-40"
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenuFor(null);
                        }}
                      />
                      <div className="absolute right-6 top-11 z-50 w-44 rounded-2xl bg-[#1c1c20] border border-white/[0.12] shadow-2xl py-1.5 overflow-hidden">
                        {onRenameSurface && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setMenuFor(null);
                              setSurfaceToRename(surf);
                            }}
                            className="w-full min-h-[44px] px-4 flex items-center gap-3 text-[14px] font-medium text-[#fafafa] hover:bg-white/[0.06]"
                          >
                            <Pencil className="w-4 h-4 text-[#a3a3a3]" />
                            <span>Rename</span>
                          </button>
                        )}
                        {onCloseSurface && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setMenuFor(null);
                              setSurfaceToClose(surf);
                            }}
                            className="w-full min-h-[44px] px-4 flex items-center gap-3 text-[14px] font-medium text-rose-400 hover:bg-rose-500/10"
                          >
                            <X className="w-4 h-4" />
                            <span>Close tab</span>
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </Pressable>
            );
          })
        )}
      </div>

      {onCreateSurface && (
        <NewSurfaceModal
          isOpen={showNewModal}
          workspaceId={workspace.id}
          workspaceTitle={workspace.title}
          onClose={() => setShowNewModal(false)}
          onCreate={onCreateSurface}
        />
      )}

      {surfaceToRename && onRenameSurface && (
        <RenameSurfaceModal
          isOpen={Boolean(surfaceToRename)}
          currentTitle={surfaceToRename.title}
          onClose={() => setSurfaceToRename(null)}
          onRename={handleConfirmRename}
        />
      )}

      {showChanges && (
        <ChangesPanel
          workspaceId={workspace.id}
          workspaceTitle={workspace.title}
          onClose={() => setShowChanges(false)}
        />
      )}

      {surfaceToClose && (
        <CloseSurfaceDialog
          isOpen={Boolean(surfaceToClose)}
          surfaceTitle={surfaceToClose.title}
          onClose={() => setSurfaceToClose(null)}
          onConfirm={handleConfirmClose}
        />
      )}
    </div>
  );
}
