import { useEffect } from "react";
import { ShieldAlert } from "lucide-react";
import type { PairingOffer } from "../../protocol/pairing";

function describe(endpoint: string): { host: string; encrypted: boolean; local: boolean } {
  try {
    const url = new URL(endpoint);
    const local =
      url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    return { host: url.host, encrypted: url.protocol === "wss:", local };
  } catch {
    return { host: endpoint, encrypted: false, local: false };
  }
}

export function PairingConfirmModal({
  offer,
  onAccept,
  onReject,
}: {
  offer: PairingOffer;
  onAccept: () => void;
  onReject: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onReject();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onReject]);

  const { host, encrypted, local } = describe(offer.endpoint);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/65 backdrop-blur-[1px]">
      <div className="w-full max-w-sm p-4 rounded-xl bg-surface border border-line-strong text-fg shadow-2xl space-y-3.5">
        <h2 className="text-[14.5px] font-semibold flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-status-wait" />
          <span>Pair with this host?</span>
        </h2>
        <div className="rounded-lg bg-bg border border-line px-3 py-2.5 space-y-0.5">
          {offer.host_name && <div className="text-[13px] font-semibold">{offer.host_name}</div>}
          <div className="text-[12px] font-mono break-all text-muted">{host}</div>
        </div>
        {!encrypted && !local && (
          <p className="text-[12px] leading-relaxed text-status-wait">
            This connection is not encrypted (ws://). Anyone on the network path can read terminal
            output and your token.
          </p>
        )}
        <p className="text-[12.5px] text-muted leading-relaxed">
          Terminal input and approvals will be sent to this host. Continue only if you created this
          link or QR code yourself.
        </p>
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={onReject}
            className="flex-1 h-9 rounded-lg bg-raised hover:bg-line-strong text-[13px] font-medium text-fg-soft"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onAccept}
            className="flex-1 h-9 rounded-lg bg-fg hover:bg-accent-strong text-[13px] font-medium text-bg"
          >
            Pair
          </button>
        </div>
      </div>
    </div>
  );
}
