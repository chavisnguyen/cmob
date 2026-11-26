import { useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  GitFork,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Terminal,
  X,
} from "lucide-react";
import type { SurfaceNode, WorkspaceNode } from "../../protocol/rpc";
import type { ConnectionState } from "../../transport/wsClient";
import { UnreadCountBadge } from "../common/UnreadCountBadge";
import { displaySurfaceTitle } from "./surfaceTitle";

const FORKABLE_AGENTS = new Set(["claude"]);

export interface SurfaceDetailHeaderProps {
  surface: SurfaceNode;
  workspace: WorkspaceNode;
  connState: ConnectionState;
  isSyncing?: boolean;
  desktopLayout: boolean;
  chatAvailable: boolean;
  activeMode: "chat" | "terminal";
  allSurfaces?: SurfaceNode[];
  canSwitchSurfaces: boolean;
  canCreateSurface: boolean;
  canRenameSurface: boolean;
  canCloseSurface: boolean;
  onBack: () => void;
  onOpenSwitcher: () => void;
  onSelectMode: (mode: "chat" | "terminal") => void;
  onOpenNewModal: () => void;
  onRequestRename: () => void;
  onRequestClose: () => void;
  onForkConversation: () => void;
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
    `flex items-center gap-1.5 ${
      compact ? "h-6 px-2.5 rounded-md text-[11.5px]" : "h-7 px-2.5 rounded-md text-[12.5px]"
    } font-medium transition-colors ${
      selected ? "bg-white/[0.1] text-fg shadow-xs" : "text-muted hover:text-fg-soft"
    }`;
  const iconCls = compact ? "w-3 h-3" : "w-3.5 h-3.5";

  return (
    <div
      className={`flex items-center ${
        compact ? "p-0.5 rounded-lg" : "p-0.5 rounded-lg"
      } bg-white/[0.04] border border-white/[0.07] shrink-0`}
    >
      <button
        type="button"
        onClick={() => onSelectMode("chat")}
        className={btnCls(activeMode === "chat")}
      >
        <MessageSquare className={iconCls} />
        <span>Chat</span>
      </button>
      <button
        type="button"
        onClick={() => onSelectMode("terminal")}
        className={btnCls(activeMode === "terminal")}
      >
        <Terminal className={iconCls} />
        <span>Term</span>
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
  chatAvailable,
  activeMode,
  allSurfaces,
  canSwitchSurfaces,
  canCreateSurface,
  canRenameSurface,
  canCloseSurface,
  onBack,
  onOpenSwitcher,
  onSelectMode,
  onOpenNewModal,
  onRequestRename,
  onRequestClose,
  onForkConversation,
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

  if (desktopLayout) {
    return (
      <header className="flex items-center justify-between gap-3 px-6 lg:px-8 h-9 bg-bg border-b border-white/[0.05] shrink-0 z-20 w-full select-none">
        <div className="flex items-center gap-2 min-w-0">
          <h1 className="text-[13px] font-medium text-fg-soft truncate">
            {displaySurfaceTitle(surface.title)}
          </h1>
          {connState !== "connected" && (
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                connState === "connecting" ? "bg-amber-400" : "bg-rose-500"
              }`}
            />
          )}
          <span className="text-[12px] text-dim truncate">· {workspace.title}</span>
          {isSyncing && (
            <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-accent-soft shrink-0">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>{connState === "connected" ? "Syncing…" : "Reconnecting…"}</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {chatAvailable && (
            <ModeSegmentedToggle activeMode={activeMode} compact onSelectMode={onSelectMode} />
          )}

          {canRenameSurface && (
            <button
              type="button"
              onClick={onRequestRename}
              className="h-7 px-2 rounded-lg hover:bg-raised text-muted hover:text-fg text-[12px] inline-flex items-center gap-1 transition-colors"
              title="Rename tab"
              aria-label="Rename Tab"
            >
              <Pencil className="w-3.5 h-3.5" />
              <span className="hidden xl:inline">Rename</span>
            </button>
          )}

          {canFork && (
            <button
              type="button"
              onClick={onForkConversation}
              className="h-7 px-2 rounded-lg hover:bg-raised text-muted hover:text-fg text-[12px] inline-flex items-center gap-1 transition-colors"
              title="Fork conversation"
              aria-label="Fork conversation"
            >
              <GitFork className="w-3.5 h-3.5" />
              <span className="hidden xl:inline">Fork</span>
            </button>
          )}

          {canCloseSurface && (
            <button
              type="button"
              onClick={onRequestClose}
              className="h-7 w-7 rounded-lg hover:bg-rose-500/15 text-muted hover:text-rose-300 flex items-center justify-center transition-colors"
              title="Close tab"
              aria-label="Close Tab"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </header>
    );
  }

  return (
    <header className="relative flex items-center justify-between gap-2 px-2 pt-[env(safe-area-inset-top,0px)] min-h-[calc(3.25rem+env(safe-area-inset-top,0px))] bg-surface border-b border-line shrink-0 z-30 w-full">
      <div className="flex items-center gap-1 min-w-0 flex-1">
        <button
          type="button"
          onClick={onBack}
          className="w-10 h-10 rounded-xl hover:bg-raised active:opacity-75 text-fg flex items-center justify-center transition-colors shrink-0"
          title={`Back to ${workspace.title}`}
          aria-label={`Back to ${workspace.title}`}
        >
          <ChevronLeft className="w-5 h-5" />
        </button>

        <button
          type="button"
          onClick={onOpenSwitcher}
          disabled={!canSwitchSurfaces}
          className="min-w-0 flex-1 pr-1 text-left rounded-lg active:opacity-75 disabled:active:opacity-100"
          aria-label={`Switch tab (current: ${surface.title})`}
        >
          <h1 className="text-[15px] font-semibold text-fg truncate leading-tight flex items-center gap-1">
            <span className="truncate">{displaySurfaceTitle(surface.title)}</span>
            {allSurfaces && allSurfaces.length > 1 && (
              <>
                <ChevronDown className="w-4 h-4 text-muted shrink-0" aria-hidden="true" />
                <span className="text-[11px] font-medium text-muted shrink-0">
                  {allSurfaces.length}
                </span>
                <UnreadCountBadge count={otherUnreadCount} size="sm" />
              </>
            )}
          </h1>
          <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
            {connState !== "connected" && (
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  connState === "connecting" ? "bg-amber-400" : "bg-rose-500"
                }`}
              />
            )}
            <p className="text-[12px] text-muted truncate leading-none">{workspace.title}</p>
            {isSyncing && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-accent-soft shrink-0 leading-none">
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                <span>{connState === "connected" ? "Syncing…" : "Reconnecting…"}</span>
              </span>
            )}
          </div>
        </button>
      </div>

      <div className="flex items-center gap-1.5 shrink-0 pr-1">
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
          className="w-9 h-9 rounded-xl bg-raised hover:bg-line active:opacity-75 text-fg flex items-center justify-center transition-colors"
          title="Tab options"
          aria-label="Tab options"
        >
          <MoreHorizontal className="w-5 h-5" />
        </button>
      </div>

      {showMoreMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowMoreMenu(false)} />
          <div className="absolute right-3 top-[calc(100%+6px)] z-50 w-52 rounded-2xl bg-surface border border-white/[0.12] shadow-2xl py-1.5 overflow-hidden">
            {canCreateSurface && (
              <button
                type="button"
                onClick={() => {
                  setShowMoreMenu(false);
                  onOpenNewModal();
                }}
                className="w-full min-h-[44px] px-4 flex items-center gap-3 text-[14px] font-medium text-fg hover:bg-white/[0.06] active:bg-white/[0.1] transition-colors"
              >
                <Plus className="w-4 h-4 text-muted" />
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
                className="w-full min-h-[44px] px-4 flex items-center gap-3 text-[14px] font-medium text-fg hover:bg-white/[0.06] active:bg-white/[0.1] transition-colors"
              >
                <Pencil className="w-4 h-4 text-muted" />
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
                className="w-full min-h-[44px] px-4 flex items-center gap-3 text-[14px] font-medium text-fg hover:bg-white/[0.06] active:bg-white/[0.1] transition-colors"
              >
                <GitFork className="w-4 h-4 text-muted" />
                <span>Fork conversation</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setShowMoreMenu(false);
                handleForceReload();
              }}
              className="w-full min-h-[44px] px-4 flex items-center gap-3 text-[14px] font-medium text-fg hover:bg-white/[0.06] active:bg-white/[0.1] transition-colors"
            >
              <RefreshCw className="w-4 h-4 text-muted" />
              <span>Reload App</span>
            </button>
            {canCloseSurface && (
              <div className="border-t border-white/[0.08] mt-1 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setShowMoreMenu(false);
                    onRequestClose();
                  }}
                  className="w-full min-h-[44px] px-4 flex items-center gap-3 text-[14px] font-medium text-rose-400 hover:bg-rose-500/10 active:bg-rose-500/20 transition-colors"
                >
                  <X className="w-4 h-4" />
                  <span>Close Tab</span>
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </header>
  );
}
