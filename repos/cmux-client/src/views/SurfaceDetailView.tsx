import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { ChatFileLinkContext } from "../components/chat/ChatFileLinkContext";
import { ChatImageContext } from "../components/chat/ChatImageContext";
import { CloseSurfaceDialog } from "../components/surface/CloseSurfaceDialog";
import { NewSurfaceModal, type CreateSurfaceParams } from "../components/surface/NewSurfaceModal";
import { RenameSurfaceModal } from "../components/surface/RenameSurfaceModal";
import {
  SurfaceDetailHeader,
  type DesktopUnifiedChromeProps,
} from "../components/surface/SurfaceDetailHeader";
import { SurfaceSwitchSheet } from "../components/surface/SurfaceSwitchSheet";
import { surfaceIdentity } from "../domain/workspaceTree";
import {
  RPC_METHODS,
  type ChatImageResult,
  type SurfaceNode,
  type WorkspaceNode,
} from "../protocol/rpc";
import { wsClient } from "../transport/wsClient";
import { useChatSessionController } from "../state/useChatSessionController";

const LazyOrcaChatView = lazy(() =>
  import("../components/chat/OrcaChatView").then((m) => ({ default: m.OrcaChatView })),
);
const LazyMarkdownFileViewer = lazy(() =>
  import("../components/files/MarkdownFileViewer").then((m) => ({ default: m.MarkdownFileViewer })),
);
const LazyRawTerminalView = lazy(() =>
  import("../components/terminal/RawTerminalView").then((m) => ({ default: m.RawTerminalView })),
);

export interface SurfaceDetailDesktopChrome extends DesktopUnifiedChromeProps {
  usageWidget?: ReactNode;
}

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
  desktopChrome?: SurfaceDetailDesktopChrome;
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
  desktopChrome,
}: SurfaceDetailViewProps) {
  const chat = useChatSessionController({ surface, workspace, onRefresh });

  const [showSwitcher, setShowSwitcher] = useState(false);
  const [showNewModal, setShowNewModal] = useState(false);
  const [surfaceToRename, setSurfaceToRename] = useState<SurfaceNode | null>(null);
  const [surfaceToClose, setSurfaceToClose] = useState<SurfaceNode | null>(null);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const agentSessionId = surface.agent?.session_id;
  const surfaceKeyForImages = chat.surfaceKey;
  const fetchChatImage = useCallback(
    async (imageId: string) => {
      const img = await wsClient.call<ChatImageResult>(RPC_METHODS.CHAT_READ_IMAGE, {
        surface_id: surfaceKeyForImages,
        session_id: agentSessionId,
        image_id: imageId,
      });
      return `data:${img.media_type};base64,${img.data}`;
    },
    [surfaceKeyForImages, agentSessionId],
  );

  useEffect(() => {
    if (chat.activeMode !== "chat") return;
    const timer = setTimeout(() => {
      void import("../components/terminal/RawTerminalView");
    }, 1500);
    return () => clearTimeout(timer);
  }, [chat.activeMode]);

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

  const isSyncing =
    chat.activeMode === "chat" &&
    chat.chatAvailable &&
    (!chat.snapshotConfirmed ||
      chat.connState === "connecting" ||
      chat.connState === "authenticating");

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
        isSyncing={isSyncing}
        desktopLayout={desktopLayout}
        desktopChrome={desktopChrome}
        chatAvailable={chat.chatAvailable}
        activeMode={chat.activeMode}
        allSurfaces={allSurfaces}
        canSwitchSurfaces={Boolean(allSurfaces && allSurfaces.length > 1 && onSelectSurface)}
        canCreateSurface={Boolean(onCreateSurface)}
        canRenameSurface={Boolean(onRenameSurface)}
        canCloseSurface={Boolean(onCloseSurface)}
        onBack={onBack}
        onSelectSurface={onSelectSurface}
        onOpenSwitcher={() => setShowSwitcher(true)}
        onSelectMode={chat.setViewMode}
        onOpenNewModal={() => setShowNewModal(true)}
        onRequestRename={() => setSurfaceToRename(surface)}
        onRequestClose={() => setSurfaceToClose(surface)}
        onForkConversation={() => void chat.handleForkConversation()}
        onRefresh={onRefresh}
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
          <Suspense fallback={<div className="flex-1 bg-bg" />}>
            <ChatFileLinkContext.Provider value={setOpenFilePath}>
              <ChatImageContext.Provider value={fetchChatImage}>
                <LazyOrcaChatView
                  key={chat.surfaceKey}
                  turns={chat.turns}
                  pendingSends={chat.pendingSends}
                  withinGrace={chat.withinGrace}
                  snapshotConfirmed={chat.snapshotConfirmed}
                  isSyncing={isSyncing}
                  connState={chat.connState}
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
                  activeSubagents={chat.activeSubagents}
                  activeBackgroundTasks={chat.activeBackgroundTasks}
                  isApproving={chat.isApproving}
                  onFollowingChange={chat.setFollowing}
                  onSend={chat.handleSendPrompt}
                  onUploadImage={chat.handleUploadImage}
                  surfaceId={chat.surfaceKey}
                  onApprove={chat.handleApprove}
                  onInterrupt={chat.handleInterrupt}
                  isDesktop={desktopLayout}
                />
              </ChatImageContext.Provider>
            </ChatFileLinkContext.Provider>
          </Suspense>
        ) : surface.surface_type && surface.surface_type !== "terminal" ? (
          <div className="h-full flex flex-col items-center justify-center gap-1 px-8 text-center">
            <p className="text-[13.5px] font-medium text-fg-soft">
              This tab can&apos;t be rendered inline
            </p>
            <p className="text-[12px] text-muted">
              It is a {surface.surface_type} surface. View it directly in cmux on your Mac.
            </p>
          </div>
        ) : (
          <Suspense fallback={<div className="flex-1 bg-bg" />}>
            <LazyRawTerminalView
              surfaceId={chat.surfaceKey}
              surfaceTitle={surface.title}
              tty={surface.tty}
              isDesktop={desktopLayout}
            />
          </Suspense>
        )}
      </div>

      {openFilePath && (
        <Suspense fallback={null}>
          <LazyMarkdownFileViewer
            workspaceId={workspace.id}
            initialPath={openFilePath}
            onClose={() => setOpenFilePath(null)}
          />
        </Suspense>
      )}

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
          className="fixed left-1/2 -translate-x-1/2 bottom-[calc(4.5rem+env(safe-area-inset-bottom,0px))] z-50 max-w-[90vw] px-3.5 py-2 rounded-lg bg-surface border border-line-strong text-[12.5px] text-fg shadow-2xl"
        >
          {chat.forkStatus}
        </div>
      )}
    </div>
  );
}
