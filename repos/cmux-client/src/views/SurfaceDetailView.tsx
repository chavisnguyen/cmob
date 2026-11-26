import { useState } from "react";
import { OrcaChatView } from "../components/chat/OrcaChatView";
import { CloseSurfaceDialog } from "../components/surface/CloseSurfaceDialog";
import { NewSurfaceModal, type CreateSurfaceParams } from "../components/surface/NewSurfaceModal";
import { RenameSurfaceModal } from "../components/surface/RenameSurfaceModal";
import { SurfaceDetailHeader } from "../components/surface/SurfaceDetailHeader";
import { SurfaceSwitchSheet } from "../components/surface/SurfaceSwitchSheet";
import { RawTerminalView } from "../components/terminal/RawTerminalView";
import { surfaceIdentity } from "../domain/workspaceTree";
import type { SurfaceNode, WorkspaceNode } from "../protocol/rpc";
import { useChatSessionController } from "../state/useChatSessionController";

interface SurfaceDetailViewProps {
  surface: SurfaceNode;
  workspace: WorkspaceNode;
  onBack: () => void;
  allSurfaces?: SurfaceNode[];
  onSelectSurface?: (surface: SurfaceNode) => void;
  onCreateSurface?: (params: CreateSurfaceParams) => Promise<void>;
  onRenameSurface?: (surfaceId: string, title: string) => Promise<void>;
  onCloseSurface?: (surfaceId: string) => Promise<void>;
  onRefresh?: () => void;
  desktopLayout?: boolean;
}

export function SurfaceDetailView({
  surface,
  workspace,
  onBack,
  allSurfaces,
  onSelectSurface,
  onCreateSurface,
  onRenameSurface,
  onCloseSurface,
  onRefresh,
  desktopLayout = false,
}: SurfaceDetailViewProps) {
  const chat = useChatSessionController({ surface, workspace, onRefresh });

  const [showSwitcher, setShowSwitcher] = useState(false);
  const [showNewModal, setShowNewModal] = useState(false);
  const [surfaceToRename, setSurfaceToRename] = useState<SurfaceNode | null>(null);
  const [surfaceToClose, setSurfaceToClose] = useState<SurfaceNode | null>(null);

  const handleConfirmRename = async (nextTitle: string) => {
    if (!surfaceToRename || !onRenameSurface) return;
    await onRenameSurface(surfaceIdentity(surfaceToRename), nextTitle);
    setSurfaceToRename(null);
  };

  const handleConfirmClose = async () => {
    if (!surfaceToClose || !onCloseSurface) return;
    const targetId = surfaceIdentity(surfaceToClose);
    const isClosingCurrent = targetId === chat.surfaceKey;

    await onCloseSurface(targetId);
    setSurfaceToClose(null);

    if (isClosingCurrent && allSurfaces && onSelectSurface) {
      const remaining = allSurfaces.filter((item) => surfaceIdentity(item) !== targetId);
      if (remaining.length > 0) onSelectSurface(remaining[0]);
      else onBack();
    }
  };

  return (
    <div
      className={`flex flex-col h-full w-full overflow-hidden bg-bg text-fg ${
        desktopLayout ? "" : "max-w-4xl mx-auto"
      }`}
    >
      <SurfaceDetailHeader
        surface={surface}
        workspace={workspace}
        connState={chat.connState}
        desktopLayout={desktopLayout}
        chatAvailable={chat.chatAvailable}
        activeMode={chat.activeMode}
        allSurfaces={allSurfaces}
        canSwitchSurfaces={Boolean(allSurfaces && allSurfaces.length > 1 && onSelectSurface)}
        canCreateSurface={Boolean(onCreateSurface)}
        canRenameSurface={Boolean(onRenameSurface)}
        canCloseSurface={Boolean(onCloseSurface)}
        onBack={onBack}
        onOpenSwitcher={() => setShowSwitcher(true)}
        onSelectMode={chat.setViewMode}
        onOpenNewModal={() => setShowNewModal(true)}
        onRequestRename={() => setSurfaceToRename(surface)}
        onRequestClose={() => setSurfaceToClose(surface)}
        onForkConversation={() => void chat.handleForkConversation()}
      />

      {showSwitcher && allSurfaces && onSelectSurface && (
        <SurfaceSwitchSheet
          surfaces={allSurfaces}
          activeSurfaceId={chat.surfaceKey}
          onSelect={onSelectSurface}
          onNew={() => setShowNewModal(true)}
          onClose={() => setShowSwitcher(false)}
        />
      )}

      <div className="flex-1 min-h-0 overflow-hidden min-w-0 max-w-full flex flex-col">
        {chat.activeMode === "chat" ? (
          <OrcaChatView
            key={chat.surfaceKey}
            turns={chat.turns}
            pendingSends={chat.pendingSends}
            withinGrace={chat.withinGrace}
            snapshotConfirmed={chat.snapshotConfirmed}
            isLoading={chat.initialLoading}
            agentKind={surface.agent?.agent_kind || "agent"}
            startupDialog={chat.startupDialog}
            onAnswerDialog={chat.handleAnswerDialog}
            onAnswerQuestion={chat.handleAnswerQuestion}
            onOpenTerminal={() => chat.setViewMode("terminal")}
            hasMoreHistory={chat.hasMoreHistory}
            isLoadingOlder={chat.loadingOlder}
            onLoadOlder={chat.handleLoadOlder}
            isWorking={chat.isWorking}
            lifecycleState={chat.lifecycleState}
            activityText={chat.activityText}
            awaitingPrompt={chat.awaitingPrompt}
            isApproving={chat.isApproving}
            onFollowingChange={chat.setFollowing}
            onSend={chat.handleSendPrompt}
            onUploadImage={chat.handleUploadImage}
            surfaceId={chat.surfaceKey}
            onApprove={chat.handleApprove}
            onInterrupt={chat.handleInterrupt}
            isDesktop={desktopLayout}
          />
        ) : surface.surface_type && surface.surface_type !== "terminal" ? (
          <div className="h-full flex flex-col items-center justify-center gap-1 px-8 text-center">
            <p className="text-[14px] font-medium text-fg-soft">
              This tab can&apos;t be shown on mobile
            </p>
            <p className="text-[12.5px] text-muted">
              It is a {surface.surface_type} tab. Open it in cmux on your computer.
            </p>
          </div>
        ) : (
          <RawTerminalView
            surfaceId={chat.surfaceKey}
            surfaceTitle={surface.title}
            tty={surface.tty}
            isDesktop={desktopLayout}
          />
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

      {surfaceToClose && (
        <CloseSurfaceDialog
          isOpen={Boolean(surfaceToClose)}
          surfaceTitle={surfaceToClose.title}
          onClose={() => setSurfaceToClose(null)}
          onConfirm={handleConfirmClose}
        />
      )}

      {chat.forkStatus && (
        <div
          role="status"
          className="fixed left-1/2 -translate-x-1/2 bottom-[calc(5rem+env(safe-area-inset-bottom,0px))] z-50 max-w-[90vw] px-4 py-2 rounded-xl bg-surface border border-white/[0.12] text-[13px] text-fg shadow-2xl"
        >
          {chat.forkStatus}
        </div>
      )}
    </div>
  );
}
