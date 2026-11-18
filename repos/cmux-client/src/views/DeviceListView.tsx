import { useCallback, useEffect, useState, type ReactElement } from "react";
import {
  Check,
  Laptop,
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
}: {
  hosts: SavedHost[];
  activeHostId: string;
  connState: ConnectionState;
  onSelectHost: (host: SavedHost) => void;
  onRemoveHost: (id: string) => void;
  onRenameHost: (id: string, name: string) => void;
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
    <div className="flex flex-col h-full overflow-y-auto bg-[#0a0a0c] text-[#fafafa] p-4 pb-[calc(6rem+env(safe-area-inset-bottom,0px))] space-y-6 max-w-2xl mx-auto w-full">
      {/* Header */}
      <div className="flex items-center justify-between pt-1">
        <div>
          <h1 className="text-[20px] font-bold tracking-tight text-[#fafafa]">Devices & Hosts</h1>
          <p className="text-[12.5px] text-[#8e8e93] mt-0.5">
            Switch between computers or manage authorized devices
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            haptic("light");
            setShowPairModal(true);
          }}
          className="min-h-[44px] px-3.5 rounded-xl bg-[#3276f2] hover:bg-[#2563eb] active:bg-[#1d4ed8] text-white text-[12.5px] font-semibold flex items-center gap-1.5 transition-colors shadow-sm cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Pair Device</span>
        </button>
      </div>

      {/* Section 1: Paired Computers (Hosts) */}
      <section className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <h2 className="text-[13px] font-semibold uppercase tracking-wider text-[#71717a]">
            Paired Computers ({hosts.length})
          </h2>
        </div>

        <div className="space-y-2">
          {hosts.map((host) => {
            const isActive = host.id === activeHostId;
            const machineType = classifyHostType(host.name || host.endpoint);
            const Icon = GLYPHS[machineType];

            return (
              <div
                key={host.id}
                className={`flex items-center justify-between p-3.5 rounded-2xl border transition-all ${
                  isActive
                    ? "bg-[#16161b] border-white/[0.14] shadow-md ring-1 ring-white/[0.05]"
                    : "bg-[#111114] border-white/[0.06] hover:border-white/[0.1]"
                }`}
              >
                <div className="flex items-center gap-3.5 min-w-0 flex-1 pr-2">
                  <div
                    className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border ${
                      isActive
                        ? "bg-[#3276f2]/15 border-[#3276f2]/30 text-[#8ab4f8]"
                        : "bg-white/[0.04] border-white/[0.06] text-[#71717a]"
                    }`}
                  >
                    <Icon className="w-5 h-5" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-semibold text-[#fafafa] truncate">
                        {host.name}
                      </span>
                      {isActive && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 text-[11px] font-medium border border-emerald-500/20">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                          <span>Active</span>
                        </span>
                      )}
                    </div>
                    <div className="text-[11.5px] font-mono text-[#71717a] truncate mt-0.5">
                      {host.endpoint}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {isActive ? (
                    <div
                      className={`min-h-[36px] px-3 rounded-lg text-[12px] font-medium flex items-center gap-1.5 ${
                        connState === "connected"
                          ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                          : connState === "connecting" || connState === "authenticating"
                            ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                            : "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                      }`}
                    >
                      {connState === "connected" ? (
                        <Check className="w-3.5 h-3.5" />
                      ) : (
                        <span className="w-2 h-2 rounded-full bg-current animate-pulse" />
                      )}
                      <span className="capitalize">{connState}</span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        haptic("light");
                        onSelectHost(host);
                      }}
                      className="min-h-[44px] px-3.5 rounded-xl bg-[#3276f2] hover:bg-[#2563eb] text-white text-[12.5px] font-semibold transition-colors cursor-pointer"
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
                    className="min-h-[44px] min-w-[44px] rounded-xl hover:bg-white/[0.08] active:bg-white/[0.12] text-[#8e8e93] hover:text-white flex items-center justify-center transition-colors cursor-pointer"
                    aria-label={`Rename ${host.name}`}
                    title="Rename"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>

                  {!isActive && (
                    <button
                      type="button"
                      onClick={() => handleDeleteHost(host)}
                      className={`min-h-[44px] min-w-[44px] px-2 rounded-xl flex items-center justify-center transition-colors cursor-pointer ${
                        confirmDeleteId === host.id
                          ? "bg-rose-500 text-white font-medium text-[11.5px] px-2.5"
                          : "hover:bg-rose-500/15 text-[#8e8e93] hover:text-rose-400"
                      }`}
                      aria-label={`Remove ${host.name}`}
                      title={confirmDeleteId === host.id ? "Click again to confirm" : "Remove host"}
                    >
                      {confirmDeleteId === host.id ? (
                        <span>Confirm</span>
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Section 2: Authorized Mobile Devices (on current gateway) */}
      <section className="space-y-3 pt-2">
        <div className="flex items-center justify-between px-1">
          <div>
            <h2 className="text-[13px] font-semibold uppercase tracking-wider text-[#71717a]">
              Authorized Mobile Devices
            </h2>
            <p className="text-[11.5px] text-[#71717a] mt-0.5">
              Phones and tablets with access to the active gateway
            </p>
          </div>
        </div>

        <div className="rounded-2xl bg-[#111114] border border-white/[0.08] divide-y divide-white/[0.06] overflow-hidden">
          {!authorizedDevices ? (
            <div className="p-4 text-center text-[12.5px] text-[#71717a]">
              Connect to a gateway to view authorized client devices.
            </div>
          ) : authorizedDevices.length === 0 ? (
            <div className="p-4 text-center text-[12.5px] text-[#71717a]">
              No paired mobile devices recorded.
            </div>
          ) : (
            authorizedDevices.map((dev) => (
              <div key={dev.id} className="flex items-center justify-between p-3.5">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-xl bg-white/[0.04] text-[#8e8e93] flex items-center justify-center shrink-0">
                    <Smartphone className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-medium text-[#fafafa] truncate">
                      {dev.label || "Mobile Device"}
                    </div>
                    <div className="text-[11.5px] text-[#71717a] flex items-center gap-2 mt-0.5">
                      <span>Seen {relativeTime(dev.last_seen)}</span>
                      <span>•</span>
                      <span className="font-mono text-[10.5px]">{(dev.id ?? "").slice(0, 8)}…</span>
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void handleRevoke(dev.id)}
                  className={`min-h-[36px] px-3 rounded-lg text-[11.5px] font-medium transition-colors cursor-pointer ${
                    revokeArmed === dev.id
                      ? "bg-rose-500 text-white"
                      : "bg-white/[0.05] hover:bg-rose-500/15 text-[#8e8e93] hover:text-rose-400"
                  }`}
                >
                  {revokeArmed === dev.id ? "Confirm Revoke" : "Revoke"}
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Section 3: Add Host Guide Banner */}
      <section className="rounded-2xl bg-[#141418] border border-white/[0.08] p-4 flex items-start gap-3.5">
        <div className="w-9 h-9 rounded-xl bg-[#3276f2]/15 text-[#8ab4f8] flex items-center justify-center shrink-0 mt-0.5">
          <QrCode className="w-5 h-5" />
        </div>
        <div className="space-y-1 min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-[#fafafa]">Connect Another Computer</div>
          <p className="text-[12px] text-[#8e8e93] leading-relaxed">
            Run{" "}
            <code className="px-1.5 py-0.5 rounded bg-black/40 text-[#8ab4f8]">
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
