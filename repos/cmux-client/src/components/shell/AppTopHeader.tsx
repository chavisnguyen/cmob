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
      className={`flex items-center justify-between px-4 ${
        compactTopInset
          ? "min-h-[52px]"
          : "pt-[env(safe-area-inset-top,0px)] min-h-[calc(3.25rem+env(safe-area-inset-top,0px))]"
      } relative bg-bg border-b border-line shrink-0`}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="text-[17px] font-bold tracking-tight text-fg shrink-0">Cmob</span>
        <button
          type="button"
          onClick={onOpenHostSheet}
          aria-label={`Switch computer (${connState})`}
          className="inline-flex items-center gap-1.5 min-w-0 max-w-[180px] pl-2.5 pr-2 py-1 rounded-full bg-raised hover:bg-line text-[12.5px] font-medium text-fg-soft transition-colors"
        >
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              connState === "connected"
                ? "bg-emerald-400"
                : connState === "connecting" || connState === "authenticating"
                  ? "bg-amber-400 animate-pulse"
                  : "bg-rose-400"
            }`}
          />
          <span className="truncate">{activeHost?.name ?? "No computer"}</span>
          <ChevronDown className="w-3 h-3 shrink-0 text-muted" />
        </button>
        {isDemoMode() && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-accent/20 text-accent-soft border border-accent/30 shrink-0">
            Demo
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={onToggleNotifications}
          className={`w-9 h-9 rounded-xl bg-raised hover:bg-line flex items-center justify-center transition-colors ${
            notifPermission === "granted"
              ? "text-emerald-400"
              : notifPermission === "denied"
                ? "text-dim cursor-not-allowed"
                : "text-amber-300"
          }`}
          title={`Notifications: ${notifPermission}`}
          aria-label="Notifications"
        >
          {notifPermission === "granted" ? (
            <BellRing className="w-[18px] h-[18px]" />
          ) : (
            <Bell className="w-[18px] h-[18px]" />
          )}
        </button>

        <button
          type="button"
          onClick={() => setShowAppMenu((v) => !v)}
          className="w-9 h-9 rounded-xl bg-raised hover:bg-line text-fg-soft flex items-center justify-center transition-colors"
          title="Menu"
          aria-label="Menu"
          aria-expanded={showAppMenu}
        >
          <MoreHorizontal className="w-[18px] h-[18px]" />
        </button>

        {showAppMenu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setShowAppMenu(false)} />
            <div className="absolute right-3 top-[calc(100%-4px)] z-50 w-56 rounded-2xl bg-surface border border-white/[0.12] shadow-2xl py-1.5 overflow-hidden">
              {[
                { label: "Pair new device", icon: Plus, run: onOpenPairModal },
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
                  className="w-full min-h-[44px] px-4 flex items-center gap-3 text-[14px] font-medium text-fg hover:bg-white/[0.06] active:bg-white/[0.1] transition-colors"
                >
                  <Icon className="w-4 h-4 text-muted" />
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
