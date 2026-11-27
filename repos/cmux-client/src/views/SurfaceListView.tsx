import { lazy, Suspense, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  GitBranch,
  Globe,
  MoreVertical,
  Pencil,
  Plus,
  RefreshCw,
  Terminal,
  X,
} from "lucide-react";
import { shortPath } from "../components/chat/textUtils";
import { AgentIcon } from "../components/common/AgentIcon";
import { agentDisplayName } from "../components/common/agentBrand";
import { Pressable } from "../components/common/Pressable";
import { UnreadCountBadge } from "../components/common/UnreadCountBadge";
import { CloseSurfaceDialog } from "../components/surface/CloseSurfaceDialog";
import { NewSurfaceModal, type CreateSurfaceParams } from "../components/surface/NewSurfaceModal";
import { RenameSurfaceModal } from "../components/surface/RenameSurfaceModal";
import { displaySurfaceTitle } from "../components/surface/surfaceTitle";
import type { SurfaceNode, WorkspaceNode } from "../protocol/rpc";

const LazyChangesPanel = lazy(() =>
  import("../components/git/ChangesPanel").then((m) => ({ default: m.ChangesPanel })),
);

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
    <div className="flex flex-col h-full w-full max-w-3xl lg:max-w-none mx-auto bg-bg text-fg">
      <header className="flex items-center justify-between gap-2 px-2.5 min-h-[46px] bg-bg border-b border-line w-full shrink-0 select-none">
        <div className="flex items-center gap-1 min-w-0 flex-1">
          <button
            type="button"
            onClick={onBack}
            className="w-9 h-9 rounded-lg hover:bg-raised active:opacity-75 text-fg flex items-center justify-center transition-colors shrink-0"
            title="Back to Workspaces"
            aria-label="Back to Workspaces"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>

          <div className="min-w-0 flex-1">
            <h1 className="text-[14.5px] font-semibold text-fg truncate leading-tight">
              {workspace.title}
            </h1>
            <p className="text-[11.5px] text-dim font-mono truncate mt-0.5">
              {shortPath(workspace.current_directory, 3)}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              className="w-8 h-8 rounded-lg hover:bg-raised active:opacity-75 text-muted hover:text-fg flex items-center justify-center transition-colors"
              title="Refresh tabs"
              aria-label="Refresh tabs"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowChanges(true)}
            className="w-8 h-8 rounded-lg hover:bg-raised text-muted hover:text-fg flex items-center justify-center transition-colors"
            title="Git changes"
            aria-label="Git changes"
          >
            <GitBranch className="w-3.5 h-3.5 text-status-ok/85" />
          </button>
          {onCreateSurface && (
            <button
              type="button"
              onClick={() => setShowNewModal(true)}
              className="h-8 px-2.5 rounded-lg bg-accent hover:bg-accent-strong active:opacity-80 text-bg text-[12.5px] font-medium inline-flex items-center gap-1 transition-colors"
              title="New Tab"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Tab</span>
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto divide-y divide-line pb-[calc(5rem+env(safe-area-inset-bottom,0px))]">
        {workspace.surfaces.length === 0 ? (
          <div className="p-10 text-center text-muted text-[13px] flex flex-col items-center justify-center gap-3">
            <p>No tabs open in this workspace.</p>
            {onCreateSurface && (
              <button
                type="button"
                onClick={() => setShowNewModal(true)}
                className="h-9 px-3.5 rounded-lg bg-accent hover:bg-accent-strong text-bg text-[13px] font-medium inline-flex items-center gap-1.5 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
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
                className="flex items-center justify-between px-4 py-2.5 hover:bg-surface/60 active:bg-surface cursor-pointer transition-colors group"
              >
                <div className="flex items-center gap-2.5 min-w-0 flex-1 pr-2">
                  <div className="w-5 h-5 flex items-center justify-center text-muted shrink-0">
                    {surf.surface_type === "markdown" ? (
                      <FileText className="w-4 h-4 text-status-wait/85" />
                    ) : surf.surface_type === "browser" ? (
                      <Globe className="w-4 h-4 text-accent/85" />
                    ) : hasAgent ? (
                      <AgentIcon kind={surf.agent?.agent_kind} size={16} />
                    ) : (
                      <Terminal className="w-4 h-4 text-status-ok/80" />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <h2 className="text-[13.5px] font-medium text-fg truncate">
                        {displaySurfaceTitle(surf.title)}
                      </h2>
                      <UnreadCountBadge count={surf.unread_count} size="sm" />
                      {surf.selected && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-accent/15 text-accent-soft border border-accent/25 shrink-0">
                          current
                        </span>
                      )}
                    </div>

                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-dim">
                      {hasAgent && (
                        <span
                          className={`inline-flex items-center gap-1 ${
                            agentStatus === "waiting"
                              ? "text-status-wait font-medium"
                              : agentStatus === "error"
                                ? "text-status-err font-medium"
                                : agentStatus === "running"
                                  ? "text-accent-soft font-medium"
                                  : "text-muted"
                          }`}
                        >
                          <span>{agentDisplayName(surf.agent?.agent_kind)}</span>
                          <span className="text-dim">· {surf.agent?.status}</span>
                        </span>
                      )}
                      {surf.tty && (
                        <span className="font-mono text-dim">
                          {hasAgent ? `· ${surf.tty}` : surf.tty}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-0.5 shrink-0 relative">
                  {(onRenameSurface || onCloseSurface) && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setMenuFor((cur) =>
                          cur === (surf.id || surf.ref) ? null : surf.id || surf.ref,
                        );
                      }}
                      className="w-8 h-8 rounded-lg text-dim hover:text-fg hover:bg-raised flex items-center justify-center transition-colors"
                      title="Tab actions"
                      aria-label="Tab actions"
                      aria-expanded={menuFor === (surf.id || surf.ref)}
                    >
                      <MoreVertical className="w-4 h-4" />
                    </button>
                  )}
                  <ChevronRight className="w-4 h-4 text-dim" />
                  {menuFor === (surf.id || surf.ref) && (
                    <>
                      <div
                        className="fixed inset-0 z-40"
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenuFor(null);
                        }}
                      />
                      <div className="absolute right-5 top-9 z-50 w-40 rounded-lg bg-surface border border-line-strong shadow-2xl py-1 overflow-hidden">
                        {onRenameSurface && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setMenuFor(null);
                              setSurfaceToRename(surf);
                            }}
                            className="w-full min-h-[38px] px-3.5 flex items-center gap-2.5 text-[13px] font-medium text-fg-soft hover:text-fg hover:bg-raised"
                          >
                            <Pencil className="w-3.5 h-3.5 text-muted" />
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
                            className="w-full min-h-[38px] px-3.5 flex items-center gap-2.5 text-[13px] font-medium text-status-err hover:bg-status-err/10"
                          >
                            <X className="w-3.5 h-3.5" />
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
        <Suspense fallback={null}>
          <LazyChangesPanel
            workspaceId={workspace.id}
            workspaceTitle={workspace.title}
            onClose={() => setShowChanges(false)}
          />
        </Suspense>
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
