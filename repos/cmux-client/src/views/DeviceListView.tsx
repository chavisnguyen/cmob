import { lazy, Suspense, useCallback, useEffect, useState, type ReactElement } from "react";
import {
  ChevronLeft,
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
import { relativeTime } from "../components/hosts/deviceUtils";
import { NotificationPrefs } from "../components/hosts/NotificationPrefs";
import { RenameHostModal } from "../components/hosts/RenameHostModal";
import { classifyHostType, type HostMachineType, type SavedHost } from "../hosts/hostStore";
import { haptic } from "../native/haptics";
import { RPC_METHODS } from "../protocol/rpc";
import { wsClient, type ConnectionState } from "../transport/wsClient";

const LazyPairHostModal = lazy(() =>
  import("../components/hosts/PairHostModal").then((m) => ({ default: m.PairHostModal })),
);

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
  hideBack = false,
}: {
  hosts: SavedHost[];
  activeHostId: string;
  connState: ConnectionState;
  onSelectHost: (host: SavedHost) => void;
  onRemoveHost: (id: string) => void;
  onRenameHost: (id: string, name: string) => void;
  onBack: () => void;
  hideBack?: boolean;
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
    <div className="flex flex-col h-full overflow-y-auto scrollbar-sleek bg-bg text-fg px-4 lg:px-8 pt-5 pb-[calc(2rem+env(safe-area-inset-bottom,0px))] space-y-5 max-w-4xl mx-auto w-full">
      {!hideBack && (
        <button
          type="button"
          onClick={onBack}
          className="-mb-3 -ml-1 self-start min-h-[34px] px-2 flex items-center gap-1 rounded-md text-[12.5px] font-medium text-muted hover:text-fg"
        >
          <ChevronLeft className="w-4 h-4" />
          <span>Workspaces</span>
        </button>
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[16px] font-semibold tracking-tight text-fg">Hosts &amp; Devices</h1>
          <p className="text-[12px] text-muted mt-0.5">
            Switch paired Macs or manage authorized mobile sessions
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            haptic("light");
            setShowPairModal(true);
          }}
          className="h-8 px-3 rounded-lg bg-accent hover:bg-accent-strong text-bg text-[12.5px] font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Pair</span>
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 items-start">
        <div className="space-y-5">
          <section className="space-y-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-dim px-0.5">
              Paired Computers ({hosts.length})
            </h2>

            <div className="rounded-xl bg-sidebar border border-line divide-y divide-line overflow-hidden">
              {hosts.length === 0 && (
                <div className="p-4 text-center text-[12.5px] text-muted">
                  No computers yet. Click Pair to add one.
                </div>
              )}
              {hosts.map((host) => {
                const isActive = host.id === activeHostId;
                const machineType = classifyHostType(host.name || host.endpoint);
                const Icon = GLYPHS[machineType];

                return (
                  <div
                    key={host.id}
                    className={`flex items-center justify-between px-3.5 py-3 transition-colors ${
                      isActive ? "bg-surface/70" : ""
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1 pr-2">
                      <Icon className="w-4 h-4 text-muted shrink-0" />

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-[13.5px] font-medium text-fg truncate">
                            {host.name}
                          </span>
                          {isActive && (
                            <span
                              className={`inline-flex items-center gap-1 text-[11px] font-medium capitalize shrink-0 ${
                                connState === "connected"
                                  ? "text-status-ok"
                                  : connState === "connecting" || connState === "authenticating"
                                    ? "text-status-wait"
                                    : "text-status-err"
                              }`}
                            >
                              <span className="w-1.5 h-1.5 rounded-full bg-current" />
                              {connState}
                            </span>
                          )}
                        </div>
                        <div className="text-[11.5px] font-mono text-dim truncate mt-0.5">
                          {host.endpoint}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {!isActive && (
                        <button
                          type="button"
                          onClick={() => {
                            haptic("light");
                            onSelectHost(host);
                          }}
                          className="h-7 px-2.5 rounded-md bg-raised hover:bg-line-strong text-fg text-[12px] font-medium transition-colors cursor-pointer"
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
                        className="w-8 h-8 rounded-md hover:bg-raised text-muted hover:text-fg flex items-center justify-center transition-colors cursor-pointer"
                        aria-label={`Rename ${host.name}`}
                        title="Rename"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDeleteHost(host)}
                        className={`h-8 min-w-[32px] px-2 rounded-md flex items-center justify-center transition-colors cursor-pointer ${
                          confirmDeleteId === host.id
                            ? "bg-status-err text-white font-medium text-[11.5px]"
                            : "hover:bg-status-err/15 text-muted hover:text-status-err"
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
                          <Trash2 className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <div className="space-y-5">
          <section className="space-y-2">
            <div className="px-0.5">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-dim">
                Authorized Devices
              </h2>
            </div>

            <div className="rounded-xl bg-sidebar border border-line divide-y divide-line overflow-hidden">
              {!authorizedDevices ? (
                <div className="p-4 text-center text-[12px] text-dim">
                  Connect to a gateway to view authorized client devices.
                </div>
              ) : authorizedDevices.length === 0 ? (
                <div className="p-4 text-center text-[12px] text-dim">
                  No paired mobile devices recorded.
                </div>
              ) : (
                authorizedDevices.map((dev) => (
                  <div key={dev.id} className="flex items-center justify-between px-3.5 py-2.5">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Smartphone className="w-4 h-4 text-muted shrink-0" />
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-fg truncate">
                          {dev.label || "Mobile Device"}
                        </div>
                        <div className="text-[11px] text-dim">
                          Seen {relativeTime(dev.last_seen)}
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => void handleRevoke(dev.id)}
                      className={`h-7 px-2.5 rounded-md text-[11.5px] font-medium transition-colors cursor-pointer ${
                        revokeArmed === dev.id
                          ? "bg-status-err text-white"
                          : "bg-raised hover:bg-status-err/15 text-muted hover:text-status-err"
                      }`}
                    >
                      {revokeArmed === dev.id ? "Confirm" : "Revoke"}
                    </button>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-dim px-0.5">
              Notifications
            </h2>
            <div className="rounded-xl bg-sidebar border border-line p-3.5">
              <NotificationPrefs />
            </div>
          </section>

          <section className="rounded-xl bg-sidebar border border-line p-3.5 flex items-start gap-3">
            <QrCode className="w-4 h-4 text-muted shrink-0 mt-0.5" />
            <div className="space-y-1 min-w-0 flex-1">
              <div className="text-[13px] font-medium text-fg">Connect Another Mac</div>
              <p className="text-[12px] text-muted leading-relaxed">
                Run{" "}
                <code className="px-1.5 py-0.5 rounded bg-surface border border-line text-fg font-mono text-[11.5px]">
                  cmob qr --tailscale
                </code>{" "}
                inside cmux to generate a one-time pairing QR code.
              </p>
            </div>
          </section>
        </div>
      </div>

      {showPairModal && (
        <Suspense fallback={null}>
          <LazyPairHostModal
            onClose={() => setShowPairModal(false)}
            onPaired={() => void refreshAuthorizedDevices()}
          />
        </Suspense>
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
