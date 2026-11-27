import { useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronLeft,
  GitFork,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import type { SurfaceNode, WorkspaceNode } from "../../protocol/rpc";
import type { ConnectionState } from "../../transport/wsClient";
import { UnreadCountBadge } from "../common/UnreadCountBadge";
import { DesktopTabStrip } from "../desktop/DesktopTabStrip";
import { displaySurfaceTitle } from "./surfaceTitle";

const FORKABLE_AGENTS = new Set(["claude"]);

export interface DesktopUnifiedChromeProps {
  sidebarCollapsed: boolean;
  loading?: boolean;
  onToggleSidebar: () => void;
  onOpenNewSurface: () => void;
  onRequestCloseSurface: (surface: SurfaceNode) => void;
  onOpenChanges: () => void;
  usageWidget?: ReactNode;
}

export interface SurfaceDetailHeaderProps {
  surface: SurfaceNode;
  workspace: WorkspaceNode;
  connState: ConnectionState;
  isSyncing?: boolean;
  desktopLayout: boolean;
  desktopChrome?: DesktopUnifiedChromeProps;
  chatAvailable: boolean;
  activeMode: "chat" | "terminal";
  allSurfaces?: SurfaceNode[];
  canSwitchSurfaces: boolean;
  canCreateSurface: boolean;
  canRenameSurface: boolean;
  canCloseSurface: boolean;
  onBack: () => void;
  onSelectSurface?: (surface: SurfaceNode) => void;
  onOpenSwitcher: () => void;
  onSelectMode: (mode: "chat" | "terminal") => void;
  onOpenNewModal: () => void;
  onRequestRename: () => void;
  onRequestClose: () => void;
  onForkConversation: () => void;
  onRefresh?: () => void;
}

function ModeSegmentedToggle({
  activeMode,
  compact,
  onSelectMode,
}: {
  activeMode: "chat" | "terminal";
  compact: boolean;
  onSelectMode: (mode: "chat" | "terminal") => void;
}) {
  const btnCls = (selected: boolean) =>
    `flex items-center justify-center ${
      compact
        ? "h-[22px] px-2 rounded-[4px] text-[11px]"
        : "h-[26px] px-2.5 rounded-[5px] text-[12px]"
    } font-medium transition-colors ${
      selected
        ? "bg-accent/18 text-accent-soft border border-accent/30"
        : "text-muted hover:text-fg-soft border border-transparent"
    }`;

  return (
    <div className="flex items-center p-[2px] rounded-[6px] bg-sidebar border border-line shrink-0">
      <button
        type="button"
        onClick={() => onSelectMode("chat")}
        className={btnCls(activeMode === "chat")}
      >
        Chat
      </button>
      <button
        type="button"
        onClick={() => onSelectMode("terminal")}
        className={btnCls(activeMode === "terminal")}
      >
        Term
      </button>
    </div>
  );
}

export function SurfaceDetailHeader({
  surface,
  workspace,
  connState,
  isSyncing = false,
  desktopLayout,
  desktopChrome,
  chatAvailable,
  activeMode,
  allSurfaces,
  canSwitchSurfaces,
  canCreateSurface,
  canRenameSurface,
  canCloseSurface,
  onBack,
  onSelectSurface,
  onOpenSwitcher,
  onSelectMode,
  onOpenNewModal,
  onRequestRename,
  onRequestClose,
  onForkConversation,
  onRefresh,
}: SurfaceDetailHeaderProps) {
  const [showMoreMenu, setShowMoreMenu] = useState(false);

  const canFork = Boolean(
    surface.agent?.session_id && FORKABLE_AGENTS.has(surface.agent.agent_kind),
  );
  const currentKey = surface.id || surface.ref;
  const otherUnreadCount = (allSurfaces ?? []).reduce(
    (sum, item) => ((item.id || item.ref) === currentKey ? sum : sum + (item.unread_count ?? 0)),
    0,
  );

  const handleForceReload = () => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("reload", Date.now().toString());
      window.location.href = url.toString();
    } catch {
      window.location.reload();
    }
  };

  if (desktopLayout && desktopChrome) {
    const extraControls = (
      <div className="flex items-center gap-1">
        {isSyncing && (
          <Loader2 className="w-3 h-3 animate-spin text-muted mr-1 shrink-0" aria-label="Syncing" />
        )}
        {chatAvailable && (
          <ModeSegmentedToggle activeMode={activeMode} compact onSelectMode={onSelectMode} />
        )}
        {canRenameSurface && (
          <button
            type="button"
            onClick={onRequestRename}
            className="w-[26px] h-[26px] rounded-[6px] hover:bg-raised text-muted hover:text-fg flex items-center justify-center transition-colors"
            title="Rename tab"
            aria-label="Rename Tab"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
        {canFork && (
          <button
            type="button"
            onClick={onForkConversation}
            className="w-[26px] h-[26px] rounded-[6px] hover:bg-raised text-muted hover:text-fg flex items-center justify-center transition-colors"
            title="Fork conversation"
            aria-label="Fork conversation"
          >
            <GitFork className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    );

    return (
      <DesktopTabStrip
        workspace={workspace}
        surfaces={allSurfaces ?? workspace.surfaces}
        activeSurface={surface}
        sidebarCollapsed={desktopChrome.sidebarCollapsed}
        loading={desktopChrome.loading}
        onToggleSidebar={desktopChrome.onToggleSidebar}
        onSelectSurface={(s) => onSelectSurface?.(s)}
        onNewSurface={desktopChrome.onOpenNewSurface}
        onCloseSurface={desktopChrome.onRequestCloseSurface}
        onOpenChanges={desktopChrome.onOpenChanges}
        onRefresh={() => onRefresh?.()}
        extraControls={extraControls}
        usageWidget={desktopChrome.usageWidget}
      />
    );
  }

  return (
    <header className="relative flex items-center justify-between gap-2 px-2 pt-[env(safe-area-inset-top,0px)] min-h-[calc(2.85rem+env(safe-area-inset-top,0px))] bg-bg border-b border-line shrink-0 z-30 w-full select-none">
      <div className="flex items-center gap-0.5 min-w-0 flex-1">
        <button
          type="button"
          onClick={onBack}
          className="w-9 h-9 rounded-lg hover:bg-raised active:opacity-75 text-fg flex items-center justify-center transition-colors shrink-0"
          title={`Back to ${workspace.title}`}
          aria-label={`Back to ${workspace.title}`}
        >
          <ChevronLeft className="w-5 h-5" />
        </button>

        <button
          type="button"
          onClick={onOpenSwitcher}
          disabled={!canSwitchSurfaces}
          className="min-w-0 flex-1 pr-1 text-left rounded-md active:opacity-75 disabled:active:opacity-100"
          aria-label={`Switch tab (current: ${surface.title})`}
        >
          <h1 className="text-[14px] font-semibold text-fg truncate leading-tight flex items-center gap-1">
            <span className="truncate">{displaySurfaceTitle(surface.title)}</span>
            {allSurfaces && allSurfaces.length > 1 && (
              <>
                <ChevronDown className="w-3.5 h-3.5 text-dim shrink-0" aria-hidden="true" />
                <span className="text-[11px] font-mono text-dim shrink-0">
                  {allSurfaces.length}
                </span>
                <UnreadCountBadge count={otherUnreadCount} size="sm" />
              </>
            )}
          </h1>
          <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
            {connState !== "connected" && (
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  connState === "connecting" ? "bg-status-wait" : "bg-status-err"
                }`}
              />
            )}
            <p className="text-[11.5px] text-muted truncate leading-none">{workspace.title}</p>
            {isSyncing && (
              <span className="inline-flex items-center gap-1 text-[11px] text-dim shrink-0 leading-none">
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                <span>{connState === "connected" ? "Syncing…" : "Reconnecting…"}</span>
              </span>
            )}
          </div>
        </button>
      </div>

      <div className="flex items-center gap-1 shrink-0 pr-1">
        {chatAvailable && (
          <ModeSegmentedToggle
            activeMode={activeMode}
            compact={false}
            onSelectMode={onSelectMode}
          />
        )}
        <button
          type="button"
          onClick={() => setShowMoreMenu((prev) => !prev)}
          className="w-8 h-8 rounded-lg hover:bg-raised active:opacity-75 text-muted hover:text-fg flex items-center justify-center transition-colors"
          title="Tab options"
          aria-label="Tab options"
        >
          <MoreHorizontal className="w-4 h-4" />
        </button>
      </div>

      {showMoreMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowMoreMenu(false)} />
          <div className="absolute right-2.5 top-[calc(100%+4px)] z-50 w-48 rounded-lg bg-surface border border-line-strong shadow-2xl py-1 overflow-hidden">
            {canCreateSurface && (
              <button
                type="button"
                onClick={() => {
                  setShowMoreMenu(false);
                  onOpenNewModal();
                }}
                className="w-full min-h-[38px] px-3.5 flex items-center gap-2.5 text-[13px] font-medium text-fg-soft hover:text-fg hover:bg-raised transition-colors"
              >
                <Plus className="w-3.5 h-3.5 text-muted" />
                <span>New Tab</span>
              </button>
            )}
            {canRenameSurface && (
              <button
                type="button"
                onClick={() => {
                  setShowMoreMenu(false);
                  onRequestRename();
                }}
                className="w-full min-h-[38px] px-3.5 flex items-center gap-2.5 text-[13px] font-medium text-fg-soft hover:text-fg hover:bg-raised transition-colors"
              >
                <Pencil className="w-3.5 h-3.5 text-muted" />
                <span>Rename Tab</span>
              </button>
            )}
            {canFork && (
              <button
                type="button"
                onClick={() => {
                  setShowMoreMenu(false);
                  onForkConversation();
                }}
                className="w-full min-h-[38px] px-3.5 flex items-center gap-2.5 text-[13px] font-medium text-fg-soft hover:text-fg hover:bg-raised transition-colors"
              >
                <GitFork className="w-3.5 h-3.5 text-muted" />
                <span>Fork Conversation</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setShowMoreMenu(false);
                handleForceReload();
              }}
              className="w-full min-h-[38px] px-3.5 flex items-center gap-2.5 text-[13px] font-medium text-fg-soft hover:text-fg hover:bg-raised transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5 text-muted" />
              <span>Reload App</span>
            </button>
            {canCloseSurface && (
              <button
                type="button"
                onClick={() => {
                  setShowMoreMenu(false);
                  onRequestClose();
                }}
                className="w-full min-h-[38px] px-3.5 flex items-center gap-2.5 text-[13px] font-medium text-status-err hover:bg-status-err/10 border-t border-line transition-colors"
              >
                <X className="w-3.5 h-3.5" />
                <span>Close Tab</span>
              </button>
            )}
          </div>
        </>
      )}
    </header>
  );
}
