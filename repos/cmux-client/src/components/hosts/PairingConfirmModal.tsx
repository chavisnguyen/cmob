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

/**
 * Pairing with another host is never automatic. A crafted link could otherwise pin this app to an
 * attacker's gateway and route terminal input and approvals there.
 */
export function PairingConfirmModal({
  offer,
  onAccept,
  onReject,
}: {
  offer: PairingOffer;
  onAccept: () => void;
  onReject: () => void;
}) {
  const { host, encrypted, local } = describe(offer.endpoint);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
      <div className="w-full max-w-sm p-5 rounded-2xl bg-[#171717] border border-white/[0.1] text-[#fafafa] shadow-2xl space-y-4">
        <h2 className="text-[16px] font-semibold flex items-center gap-2.5">
          <ShieldAlert className="w-5 h-5 text-amber-300" />
          <span>Pair with this host?</span>
        </h2>
        <div className="rounded-xl bg-[#0a0a0a] border border-white/[0.1] px-3.5 py-3 space-y-1">
          {offer.host_name && <div className="text-[14px] font-semibold">{offer.host_name}</div>}
          <div className="text-[13px] font-mono break-all text-[#d4d4d4]">{host}</div>
        </div>
        {!encrypted && !local && (
          <p className="text-[12.5px] leading-relaxed text-amber-300">
            This connection is not encrypted (ws://). Anyone on the network path can read terminal
            output and your token.
          </p>
        )}
        <p className="text-[13px] text-[#a3a3a3] leading-relaxed">
          Terminal input and approvals will be sent to this host. Continue only if you created this
          link or QR code yourself.
        </p>
        <div className="flex items-center gap-2.5 pt-1">
          <button
            type="button"
            onClick={onReject}
            className="flex-1 h-11 rounded-xl bg-[#262626] hover:bg-[#303036] text-[14px] font-semibold text-[#e5e5e5]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onAccept}
            className="flex-1 h-11 rounded-xl bg-[#3276f2] hover:bg-[#2563eb] text-[14px] font-semibold text-white"
          >
            Pair
          </button>
        </div>
      </div>
    </div>
  );
}
