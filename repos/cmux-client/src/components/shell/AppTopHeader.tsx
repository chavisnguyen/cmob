import { useState } from "react";
import {
  Bell,
  BellRing,
  ChevronDown,
  Gauge,
  KeyRound,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Server,
} from "lucide-react";
import { isDemoMode } from "../../demo/demoData";
import type { MainTab } from "../../domain/workspaceTree";
import type { SavedHost } from "../../hosts/hostStore";
import { haptic } from "../../native/haptics";
import type { ConnectionState } from "../../transport/wsClient";

export interface AppTopHeaderProps {
  connState: ConnectionState;
  activeHost: SavedHost | null;
  notifPermission: NotificationPermission;
  compactTopInset: boolean;
  onOpenHostSheet: () => void;
  onToggleNotifications: () => void;
  onOpenPairModal: () => void;
  onSelectMainTab: (tab: MainTab) => void;
  onOpenTokenModal: () => void;
}

export function AppTopHeader({
  connState,
  activeHost,
  notifPermission,
  compactTopInset,
  onOpenHostSheet,
  onToggleNotifications,
  onOpenPairModal,
  onSelectMainTab,
  onOpenTokenModal,
}: AppTopHeaderProps) {
  const [showAppMenu, setShowAppMenu] = useState(false);

  const handleForceReload = () => {
    haptic("medium");
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("reload", Date.now().toString());
      window.location.href = url.toString();
    } catch {
      window.location.reload();
    }
  };

  return (
    <div
      className={`flex items-center justify-between px-3 ${
        compactTopInset
          ? "h-[38px]"
          : "pt-[env(safe-area-inset-top,0px)] min-h-[calc(2.75rem+env(safe-area-inset-top,0px))]"
      } relative bg-transparent border-b border-line shrink-0 select-none`}
    >
      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        <span className="text-[13px] font-semibold tracking-tight text-fg shrink-0">cmob</span>
        <span className="text-dim text-[12px] select-none">/</span>
        <button
          type="button"
          onClick={onOpenHostSheet}
          aria-label={`Switch computer (${connState})`}
          className="inline-flex items-center gap-1.5 min-w-0 max-w-[180px] px-1.5 py-0.5 rounded-[5px] hover:bg-raised text-[12px] font-medium text-fg-soft hover:text-fg transition-colors"
        >
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              connState === "connected"
                ? "bg-status-ok"
                : connState === "connecting" || connState === "authenticating"
                  ? "bg-status-wait"
                  : "bg-status-err"
            }`}
          />
          <span className="truncate">{activeHost?.name ?? "No computer"}</span>
          <ChevronDown className="w-3 h-3 shrink-0 text-dim" />
        </button>
        {isDemoMode() && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-raised text-muted shrink-0">
            demo
          </span>
        )}
      </div>

      <div className="flex items-center gap-0.5 shrink-0">
        <button
          type="button"
          onClick={onToggleNotifications}
          className={`w-7 h-7 rounded-[6px] hover:bg-raised flex items-center justify-center transition-colors ${
            notifPermission === "granted"
              ? "text-muted hover:text-fg"
              : notifPermission === "denied"
                ? "text-dim cursor-not-allowed"
                : "text-status-wait"
          }`}
          title={`Notifications: ${notifPermission}`}
          aria-label="Notifications"
        >
          {notifPermission === "granted" ? (
            <BellRing className="w-3.5 h-3.5" />
          ) : (
            <Bell className="w-3.5 h-3.5" />
          )}
        </button>

        <button
          type="button"
          onClick={() => setShowAppMenu((v) => !v)}
          className="w-7 h-7 rounded-[6px] hover:bg-raised text-muted hover:text-fg flex items-center justify-center transition-colors"
          title="Menu"
          aria-label="Menu"
          aria-expanded={showAppMenu}
        >
          <MoreHorizontal className="w-4 h-4" />
        </button>

        {showAppMenu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setShowAppMenu(false)} />
            <div className="absolute right-2.5 top-[calc(100%+4px)] z-50 w-52 rounded-lg bg-surface border border-line-strong shadow-2xl py-1 overflow-hidden">
              {[
                { label: "Pair new computer", icon: Plus, run: onOpenPairModal },
                { label: "Model usage", icon: Gauge, run: () => onSelectMainTab("usage") },
                { label: "Hosts & devices", icon: Server, run: () => onSelectMainTab("devices") },
                { label: "Auth token", icon: KeyRound, run: onOpenTokenModal },
                { label: "Reload app", icon: RefreshCw, run: handleForceReload },
              ].map(({ label, icon: Icon, run }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => {
                    setShowAppMenu(false);
                    run();
                  }}
                  className="w-full min-h-[34px] px-3 flex items-center gap-2.5 text-[12.5px] font-medium text-fg-soft hover:text-fg hover:bg-raised transition-colors"
                >
                  <Icon className="w-3.5 h-3.5 text-muted" />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
