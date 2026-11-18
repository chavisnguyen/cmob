import { useCallback, useEffect, useState } from "react";
import { Laptop, QrCode, Server, Smartphone, Trash2, X } from "lucide-react";
import { loadHosts, removeHost, type SavedHost } from "../../hosts/hostStore";
import { parsePairingInput } from "../../protocol/pairing";
import { RPC_METHODS } from "../../protocol/rpc";
import { wsClient } from "../../transport/wsClient";
import { NotificationPrefs } from "./NotificationPrefs";
import { QrScanModal } from "./QrScanModal";
import { canScanQr, relativeTime } from "./deviceUtils";

interface DeviceInfo {
  id: string;
  label: string;
  created_at: number;
  last_seen: number;
}

export function HostsModal({ onClose }: { onClose: () => void }) {
  const [hosts, setHosts] = useState<SavedHost[]>(() => loadHosts(localStorage));
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [revokeArmed, setRevokeArmed] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const active = wsClient.getEndpoint();

  const refreshDevices = useCallback(async () => {
    if (wsClient.getState() !== "connected") {
      setDevices(null);
      return;
    }
    try {
      const resp = await wsClient.call<{ devices: DeviceInfo[] }>(RPC_METHODS.DEVICE_LIST);
      setDevices(resp.devices ?? []);
    } catch {
      setDevices(null);
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  const propose = (text: string): boolean => {
    const offer = parsePairingInput(text);
    if (!offer || !wsClient.proposePairing(offer)) {
      setPasteError("That is not a valid pairing link or code.");
      return false;
    }
    onClose();
    return true;
  };

  const handleScan = useCallback(
    (text: string) => {
      setScanning(false);
      propose(text);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const revoke = async (id: string) => {
    if (revokeArmed !== id) {
      setRevokeArmed(id); // second tap confirms (no browser dialogs)
      return;
    }
    setRevokeArmed(null);
    try {
      await wsClient.call(RPC_METHODS.DEVICE_REVOKE, { device_id: id });
    } finally {
      await refreshDevices();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
      <div className="w-full max-w-sm max-h-[85dvh] overflow-y-auto p-5 rounded-2xl bg-bg border border-white/[0.1] text-fg shadow-2xl space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-[16px] font-semibold flex items-center gap-2.5">
            <Server className="w-5 h-5 text-accent-soft" />
            <span>Hosts</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg hover:bg-white/[0.08] text-muted flex items-center justify-center"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <section className="space-y-2">
          {hosts.length === 0 && (
            <p className="text-[13px] text-muted">
              No saved hosts yet. Connect once and it appears here.
            </p>
          )}
          {hosts.map((h) => {
            const isActive = h.endpoint === active;
            return (
              <div
                key={h.id}
                className="flex items-center gap-2 rounded-xl bg-bg border border-white/[0.1] px-3 py-2.5"
              >
                <Laptop
                  className={`w-4 h-4 shrink-0 ${isActive ? "text-emerald-400" : "text-dim"}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-semibold truncate">{h.name}</div>
                  <div className="text-[11.5px] font-mono text-dim truncate">{h.endpoint}</div>
                </div>
                {isActive ? (
                  <span className="text-[12px] text-emerald-400 font-semibold">Active</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      wsClient.switchHost(h);
                      onClose();
                    }}
                    className="h-8 px-3 rounded-lg bg-accent text-[12.5px] font-semibold text-white"
                  >
                    Switch
                  </button>
                )}
                {!isActive && (
                  <button
                    type="button"
                    onClick={() => setHosts(removeHost(localStorage, h.id))}
                    className="w-8 h-8 rounded-lg hover:bg-white/[0.08] text-muted flex items-center justify-center"
                    aria-label={`Remove ${h.name}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            );
          })}
        </section>

        <section className="space-y-2">
          <h3 className="text-[13px] font-semibold text-fg-soft">Add a host</h3>
          <input
            type="text"
            value={pasted}
            onChange={(e) => {
              setPasted(e.target.value);
              setPasteError(null);
            }}
            placeholder="Paste pairing link or code"
            className="w-full h-11 bg-bg border border-white/[0.14] focus:border-accent rounded-xl px-3.5 text-[14px] font-mono text-fg placeholder-dim outline-none"
          />
          {pasteError && <p className="text-[12.5px] text-rose-400">{pasteError}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!pasted.trim()}
              onClick={() => propose(pasted)}
              className="flex-1 h-10 rounded-xl bg-accent disabled:opacity-40 text-[13.5px] font-semibold text-white"
            >
              Continue
            </button>
            {canScanQr() && (
              <button
                type="button"
                onClick={() => setScanning(true)}
                className="h-10 px-3.5 rounded-xl bg-raised hover:bg-line text-[13.5px] font-semibold flex items-center gap-1.5"
              >
                <QrCode className="w-4 h-4" /> Scan
              </button>
            )}
          </div>
        </section>

        <NotificationPrefs />

        {devices && (
          <section className="space-y-2">
            <h3 className="text-[13px] font-semibold text-fg-soft">
              Devices paired with this host
            </h3>
            {devices.length === 0 && <p className="text-[13px] text-muted">None.</p>}
            {devices.map((d) => (
              <div
                key={d.id}
                className="flex items-center gap-2 rounded-xl bg-bg border border-white/[0.1] px-3 py-2.5"
              >
                <Smartphone className="w-4 h-4 text-dim shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-semibold truncate">{d.label}</div>
                  <div className="text-[11.5px] text-dim">
                    Last seen {relativeTime(d.last_seen)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void revoke(d.id)}
                  className={`h-8 px-3 rounded-lg text-[12.5px] font-semibold ${
                    revokeArmed === d.id ? "bg-rose-500 text-white" : "bg-raised text-rose-300"
                  }`}
                >
                  {revokeArmed === d.id ? "Confirm" : "Revoke"}
                </button>
              </div>
            ))}
          </section>
        )}
      </div>
      {scanning && <QrScanModal onResult={handleScan} onClose={() => setScanning(false)} />}
    </div>
  );
}
