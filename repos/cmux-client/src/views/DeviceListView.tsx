import { NotificationPrefs } from "../components/hosts/NotificationPrefs";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import {
  Laptop,
  ChevronLeft,
  Monitor,
  Pencil,
  Plus,
  QrCode,
  Server,
  Smartphone,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { classifyHostType, type HostMachineType, type SavedHost } from "../hosts/hostStore";
import { RPC_METHODS } from "../protocol/rpc";
import { wsClient, type ConnectionState } from "../transport/wsClient";
import { relativeTime } from "../components/hosts/deviceUtils";
import { PairHostModal } from "../components/hosts/PairHostModal";
import { RenameHostModal } from "../components/hosts/RenameHostModal";
import { haptic } from "../native/haptics";

const GLYPHS: Record<HostMachineType, LucideIcon> = {
  laptop: Laptop,
  desktop: Monitor,
  server: Server,
};

interface DeviceInfo {
  id: string;
  label: string;
  created_at: number;
  last_seen: number;
}

export function DeviceListView({
  hosts,
  activeHostId,
  connState,
  onSelectHost,
  onRemoveHost,
  onRenameHost,
  onBack,
}: {
  hosts: SavedHost[];
  activeHostId: string;
  connState: ConnectionState;
  onSelectHost: (host: SavedHost) => void;
  onRemoveHost: (id: string) => void;
  onRenameHost: (id: string, name: string) => void;
  onBack: () => void;
}): ReactElement {
  const [showPairModal, setShowPairModal] = useState(false);
  const [editingHost, setEditingHost] = useState<SavedHost | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [authorizedDevices, setAuthorizedDevices] = useState<DeviceInfo[] | null>(null);
  const [revokeArmed, setRevokeArmed] = useState<string | null>(null);

  const refreshAuthorizedDevices = useCallback(async () => {
    if (wsClient.getState() !== "connected") {
      setAuthorizedDevices(null);
      return;
    }
    try {
      const resp = await wsClient.call<{ devices?: unknown }>(RPC_METHODS.DEVICE_LIST);
      setAuthorizedDevices(Array.isArray(resp?.devices) ? (resp.devices as DeviceInfo[]) : []);
    } catch {
      setAuthorizedDevices(null);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      if (wsClient.getState() === "connected") {
        try {
          const resp = await wsClient.call<{ devices?: unknown }>(RPC_METHODS.DEVICE_LIST);
          if (active) {
            setAuthorizedDevices(
              Array.isArray(resp?.devices) ? (resp.devices as DeviceInfo[]) : [],
            );
          }
        } catch {
          if (active) setAuthorizedDevices(null);
        }
      } else {
        if (active) setAuthorizedDevices(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [connState, activeHostId]);

  useEffect(() => {
    if (confirmDeleteId) {
      const timer = setTimeout(() => setConfirmDeleteId(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [confirmDeleteId]);

  useEffect(() => {
    if (revokeArmed) {
      const timer = setTimeout(() => setRevokeArmed(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [revokeArmed]);

  const handleRevoke = async (id: string) => {
    if (revokeArmed !== id) {
      haptic("medium");
      setRevokeArmed(id);
      return;
    }
    setRevokeArmed(null);
    haptic("medium");
    try {
      await wsClient.call(RPC_METHODS.DEVICE_REVOKE, { device_id: id });
    } finally {
      await refreshAuthorizedDevices();
    }
  };

  const handleDeleteHost = (host: SavedHost) => {
    if (confirmDeleteId !== host.id) {
      haptic("medium");
      setConfirmDeleteId(host.id);
      return;
    }
    setConfirmDeleteId(null);
    haptic("medium");
    onRemoveHost(host.id);
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-bg text-fg px-5 pt-5 pb-[calc(2rem+env(safe-area-inset-bottom,0px))] space-y-8 max-w-2xl mx-auto w-full">
      <button
        type="button"
        onClick={onBack}
        className="-mb-4 -ml-1 self-start min-h-[40px] px-2 flex items-center gap-1 rounded-lg text-[13px] font-medium text-muted hover:text-fg"
      >
        <ChevronLeft className="w-4 h-4" />
        <span>Workspaces</span>
      </button>

      {/* Header */}
      <div className="flex items-start justify-between gap-3 pt-1">
        <div className="min-w-0">
          <h1 className="text-[20px] font-bold tracking-tight text-fg">Devices & Hosts</h1>
          <p className="text-[12.5px] text-muted mt-0.5">
            Switch between computers or manage authorized devices
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            haptic("light");
            setShowPairModal(true);
          }}
          className="min-h-[40px] px-3.5 rounded-xl bg-accent hover:bg-accent-strong active:bg-accent-strong text-white text-[13px] font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Pair</span>
        </button>
      </div>

      {/* Section 1: Paired Computers (Hosts) */}
      <section className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <h2 className="text-[13px] font-semibold uppercase tracking-wider text-dim">
            Paired Computers ({hosts.length})
          </h2>
        </div>

        <div className="space-y-2.5">
          {hosts.length === 0 && (
            <div className="rounded-2xl bg-surface p-4 text-center text-[12.5px] text-muted">
              No computers yet. Tap Pair to add one.
            </div>
          )}
          {hosts.map((host) => {
            const isActive = host.id === activeHostId;
            const machineType = classifyHostType(host.name || host.endpoint);
            const Icon = GLYPHS[machineType];

            return (
              <div
                key={host.id}
                className={`flex items-center justify-between p-3.5 rounded-2xl border transition-all ${
                  isActive
                    ? "bg-surface border-white/[0.14]"
                    : "bg-surface border-white/[0.06] hover:border-white/[0.1]"
                }`}
              >
                <div className="flex items-center gap-3.5 min-w-0 flex-1 pr-2">
                  <div
                    className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border ${
                      isActive
                        ? "bg-accent/15 border-accent/30 text-accent-soft"
                        : "bg-white/[0.04] border-white/[0.06] text-dim"
                    }`}
                  >
                    <Icon className="w-5 h-5" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-semibold text-fg truncate">{host.name}</div>
                    <div className="text-[11.5px] font-mono text-dim truncate mt-0.5">
                      {host.endpoint}
                    </div>
                    {isActive && (
                      <div
                        className={`mt-1 flex items-center gap-1.5 text-[11.5px] font-medium capitalize ${
                          connState === "connected"
                            ? "text-emerald-400"
                            : connState === "connecting" || connState === "authenticating"
                              ? "text-amber-400"
                              : "text-rose-400"
                        }`}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full bg-current ${connState === "connected" ? "" : "animate-pulse"}`}
                        />
                        {connState}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {!isActive && (
                    <button
                      type="button"
                      onClick={() => {
                        haptic("light");
                        onSelectHost(host);
                      }}
                      className="min-h-[44px] px-3.5 rounded-xl bg-accent hover:bg-accent-strong text-white text-[12.5px] font-semibold transition-colors cursor-pointer"
                    >
                      Switch
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      haptic("light");
                      setEditingHost(host);
                    }}
                    className="min-h-[44px] min-w-[44px] rounded-xl hover:bg-white/[0.08] active:bg-white/[0.12] text-muted hover:text-white flex items-center justify-center transition-colors cursor-pointer"
                    aria-label={`Rename ${host.name}`}
                    title="Rename"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>

                  <button
                    type="button"
                    onClick={() => handleDeleteHost(host)}
                    className={`min-h-[44px] min-w-[44px] px-2 rounded-xl flex items-center justify-center transition-colors cursor-pointer ${
                      confirmDeleteId === host.id
                        ? "bg-rose-500 text-white font-medium text-[11.5px] px-2.5"
                        : "hover:bg-rose-500/15 text-muted hover:text-rose-400"
                    }`}
                    aria-label={`Remove ${host.name}`}
                    title={
                      confirmDeleteId === host.id
                        ? "Click again to confirm"
                        : isActive
                          ? "Disconnect and remove"
                          : "Remove host"
                    }
                  >
                    {confirmDeleteId === host.id ? (
                      <span>Confirm</span>
                    ) : (
                      <Trash2 className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Section 2: Authorized Mobile Devices (on current gateway) */}
      <section className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <div>
            <h2 className="text-[13px] font-semibold uppercase tracking-wider text-dim">
              Authorized Mobile Devices
            </h2>
            <p className="text-[11.5px] text-dim mt-0.5">
              Phones and tablets with access to the active gateway
            </p>
          </div>
        </div>

        <div className="rounded-2xl bg-surface border border-white/[0.06] divide-y divide-white/[0.06] overflow-hidden">
          {!authorizedDevices ? (
            <div className="p-4 text-center text-[12.5px] text-dim">
              Connect to a gateway to view authorized client devices.
            </div>
          ) : authorizedDevices.length === 0 ? (
            <div className="p-4 text-center text-[12.5px] text-dim">
              No paired mobile devices recorded.
            </div>
          ) : (
            authorizedDevices.map((dev) => (
              <div key={dev.id} className="flex items-center justify-between p-3.5">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-xl bg-white/[0.04] text-muted flex items-center justify-center shrink-0">
                    <Smartphone className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-medium text-fg truncate">
                      {dev.label || "Mobile Device"}
                    </div>
                    <div className="text-[11.5px] text-dim mt-0.5">
                      Seen {relativeTime(dev.last_seen)}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void handleRevoke(dev.id)}
                  className={`min-h-[36px] px-3 rounded-lg text-[11.5px] font-medium transition-colors cursor-pointer ${
                    revokeArmed === dev.id
                      ? "bg-rose-500 text-white"
                      : "bg-white/[0.05] hover:bg-rose-500/15 text-muted hover:text-rose-400"
                  }`}
                >
                  {revokeArmed === dev.id ? "Confirm Revoke" : "Revoke"}
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Section 3: Notifications */}
      <section className="space-y-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-wider text-dim px-1">
          Notifications
        </h2>
        <div className="rounded-2xl bg-surface border border-white/[0.06] p-4">
          <NotificationPrefs />
        </div>
      </section>

      {/* Section 4: Add Host Guide Banner */}
      <section className="rounded-2xl bg-surface border border-white/[0.06] p-4 flex items-start gap-3.5">
        <div className="w-9 h-9 rounded-xl bg-accent/15 text-accent-soft flex items-center justify-center shrink-0 mt-0.5">
          <QrCode className="w-5 h-5" />
        </div>
        <div className="space-y-1 min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-fg">Connect Another Computer</div>
          <p className="text-[12px] text-muted leading-relaxed">
            Run{" "}
            <code className="px-1.5 py-0.5 rounded bg-black/40 text-accent-soft">
              cmob qr --tailscale
            </code>{" "}
            in your cmux terminal to scan its QR code and add it to your devices list.
          </p>
        </div>
      </section>

      {/* Modals */}
      {showPairModal && (
        <PairHostModal
          onClose={() => setShowPairModal(false)}
          onPaired={() => void refreshAuthorizedDevices()}
        />
      )}

      {editingHost && (
        <RenameHostModal
          host={editingHost}
          onRename={(newName) => onRenameHost(editingHost.id, newName)}
          onClose={() => setEditingHost(null)}
        />
      )}
    </div>
  );
}
