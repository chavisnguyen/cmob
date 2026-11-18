import { useState, type ReactElement } from "react";
import {
  Bell,
  BellRing,
  ExternalLink,
  KeyRound,
  Laptop,
  Moon,
  RefreshCw,
  Server,
  Share2,
  Sparkles,
} from "lucide-react";
import { type SavedHost } from "../hosts/hostStore";
import { type ConnectionState } from "../transport/wsClient";
import { NotificationPrefs } from "../components/hosts/NotificationPrefs";
import { pushManager } from "../notifications/pushManager";
import { type LocalNotificationPrefs } from "../notifications/localPrefs";
import { haptic } from "../native/haptics";

export function SettingsView({
  activeHost,
  connState,
  onOpenTokenModal,
  onNavigateToDevices,
}: {
  activeHost: SavedHost | null;
  connState: ConnectionState;
  onOpenTokenModal: () => void;
  onNavigateToDevices: () => void;
  localPrefs?: LocalNotificationPrefs;
  onUpdateLocalPrefs?: (prefs: LocalNotificationPrefs) => void;
}): ReactElement {
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>(() =>
    pushManager.getPermission(),
  );

  const handleTogglePush = async () => {
    try {
      const perm = await pushManager.requestPermission();
      setNotifPermission(perm);
      if (perm === "granted") {
        haptic("success");
      }
    } catch (err) {
      console.warn("Failed to enable push:", err);
    }
  };

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
    <div className="flex flex-col h-full overflow-y-auto bg-[#0a0a0c] text-[#fafafa] p-4 pb-28 space-y-6 max-w-2xl mx-auto w-full">
      {/* Header */}
      <div className="pt-1">
        <h1 className="text-[20px] font-bold tracking-tight text-[#fafafa]">Settings</h1>
        <p className="text-[12.5px] text-[#8e8e93] mt-0.5">
          Configure notifications, devices, and preferences
        </p>
      </div>

      {/* Section 1: Active Connection */}
      <section className="space-y-2">
        <h2 className="text-[12.5px] font-semibold uppercase tracking-wider text-[#71717a] px-1">
          Active Connection
        </h2>
        <div className="rounded-2xl bg-[#111114] border border-white/[0.08] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-xl bg-[#3276f2]/15 text-[#8ab4f8] flex items-center justify-center shrink-0">
                <Laptop className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="text-[14px] font-semibold text-[#fafafa] truncate">
                  {activeHost?.name || "No Active Host"}
                </div>
                <div className="text-[11.5px] font-mono text-[#71717a] truncate">
                  {activeHost?.endpoint || "Disconnected"}
                </div>
              </div>
            </div>

            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-medium ${
                connState === "connected"
                  ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20"
                  : connState === "connecting" || connState === "authenticating"
                    ? "bg-amber-500/15 text-amber-400 border border-amber-500/20"
                    : "bg-rose-500/15 text-rose-400 border border-rose-500/20"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  connState === "connected"
                    ? "bg-emerald-400"
                    : connState === "connecting" || connState === "authenticating"
                      ? "bg-amber-400 animate-pulse"
                      : "bg-rose-400"
                }`}
              />
              <span className="capitalize">{connState}</span>
            </span>
          </div>

          <div className="flex items-center gap-2 pt-1 border-t border-white/[0.06]">
            <button
              type="button"
              onClick={() => {
                haptic("light");
                onNavigateToDevices();
              }}
              className="flex-1 min-h-[44px] rounded-xl bg-[#1a1a20] hover:bg-[#24242c] active:bg-[#2e2e38] text-[13px] font-medium text-[#e5e5e5] flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <Server className="w-4 h-4 text-[#8ab4f8]" />
              <span>Manage Devices</span>
            </button>
            <button
              type="button"
              onClick={() => {
                haptic("light");
                onOpenTokenModal();
              }}
              className="min-h-[44px] px-4 rounded-xl bg-[#1a1a20] hover:bg-[#24242c] active:bg-[#2e2e38] text-[13px] font-medium text-[#e5e5e5] flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <KeyRound className="w-4 h-4 text-[#a1a1aa]" />
              <span>Token</span>
            </button>
          </div>
        </div>
      </section>

      {/* Section 2: Notifications */}
      <section className="space-y-2">
        <h2 className="text-[12.5px] font-semibold uppercase tracking-wider text-[#71717a] px-1">
          Notification Preferences
        </h2>
        <div className="rounded-2xl bg-[#111114] border border-white/[0.08] p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div
                className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                  notifPermission === "granted"
                    ? "bg-emerald-500/15 text-emerald-400"
                    : "bg-amber-500/15 text-amber-400"
                }`}
              >
                {notifPermission === "granted" ? (
                  <BellRing className="w-5 h-5" />
                ) : (
                  <Bell className="w-5 h-5" />
                )}
              </div>
              <div>
                <div className="text-[13.5px] font-medium text-[#fafafa]">Web Push Alerts</div>
                <div className="text-[11.5px] text-[#71717a]">
                  System Permission:{" "}
                  <span className="capitalize text-[#d4d4d8] font-medium">{notifPermission}</span>
                </div>
              </div>
            </div>

            {notifPermission !== "granted" && (
              <button
                type="button"
                onClick={handleTogglePush}
                className="min-h-[44px] px-3.5 rounded-xl bg-[#3276f2] hover:bg-[#2563eb] active:bg-[#1d4ed8] text-white text-[12.5px] font-semibold transition-colors cursor-pointer"
              >
                Enable Push
              </button>
            )}
          </div>

          <div className="pt-2 border-t border-white/[0.06]">
            <NotificationPrefs />
          </div>
        </div>
      </section>

      {/* Section 3: App & Diagnostics */}
      <section className="space-y-2">
        <h2 className="text-[12.5px] font-semibold uppercase tracking-wider text-[#71717a] px-1">
          App & System
        </h2>
        <div className="rounded-2xl bg-[#111114] border border-white/[0.08] divide-y divide-white/[0.06] overflow-hidden">
          <div className="flex items-center justify-between p-3.5 min-h-[44px]">
            <div className="flex items-center gap-3">
              <Sparkles className="w-4 h-4 text-[#8ab4f8]" />
              <span className="text-[13.5px] text-[#e5e5e5]">Companion App</span>
            </div>
            <span className="text-[12.5px] font-mono text-[#71717a]">cmob v0.1.4</span>
          </div>

          <div className="flex items-center justify-between p-3.5 min-h-[44px]">
            <div className="flex items-center gap-3">
              <Moon className="w-4 h-4 text-[#a1a1aa]" />
              <span className="text-[13.5px] text-[#e5e5e5]">Theme</span>
            </div>
            <span className="text-[12.5px] text-[#71717a]">Orca Dark</span>
          </div>

          <button
            type="button"
            onClick={handleForceReload}
            className="w-full flex items-center justify-between p-3.5 min-h-[44px] hover:bg-white/[0.04] active:bg-white/[0.08] transition-colors text-left cursor-pointer"
          >
            <div className="flex items-center gap-3">
              <RefreshCw className="w-4 h-4 text-[#a1a1aa]" />
              <div>
                <div className="text-[13.5px] text-[#e5e5e5]">Reload Application</div>
                <div className="text-[11.5px] text-[#71717a]">
                  Clear memory state and reload fresh bundle
                </div>
              </div>
            </div>
          </button>

          <a
            href="https://github.com/chavisnguyen/cmob"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between p-3.5 min-h-[44px] hover:bg-white/[0.04] active:bg-white/[0.08] transition-colors"
          >
            <div className="flex items-center gap-3">
              <ExternalLink className="w-4 h-4 text-[#a1a1aa]" />
              <span className="text-[13.5px] text-[#e5e5e5]">GitHub Repository</span>
            </div>
            <span className="text-[12px] text-[#71717a]">chavisnguyen/cmob</span>
          </a>
        </div>
      </section>

      {/* iOS PWA Tip */}
      <section className="rounded-2xl bg-[#141418] border border-white/[0.08] p-4 flex items-start gap-3.5">
        <div className="w-9 h-9 rounded-xl bg-white/[0.06] text-[#e5e5e5] flex items-center justify-center shrink-0 mt-0.5">
          <Share2 className="w-4 h-4" />
        </div>
        <div className="space-y-1 min-w-0">
          <div className="text-[13px] font-semibold text-[#fafafa]">iOS Home Screen Tip</div>
          <p className="text-[11.5px] text-[#8e8e93] leading-relaxed">
            In Safari on iPhone/iPad, tap <span className="font-semibold text-white">Share</span>{" "}
            then <span className="font-semibold text-white">Add to Home Screen</span> to enable
            lock-screen push alerts and fullscreen experience.
          </p>
        </div>
      </section>
    </div>
  );
}
