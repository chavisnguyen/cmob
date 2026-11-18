import { useState, useCallback, useEffect, type ReactElement } from "react";
import { Laptop, QrCode, Server, X } from "lucide-react";
import { parsePairingInput } from "../../protocol/pairing";
import { wsClient } from "../../transport/wsClient";
import { canScanQr } from "./deviceUtils";
import { QrScanModal } from "./QrScanModal";
import { haptic } from "../../native/haptics";

export function PairHostModal({
  onClose,
  onPaired,
}: {
  onClose: () => void;
  onPaired?: () => void;
}): ReactElement {
  const [pasted, setPasted] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const propose = useCallback(
    (text: string): boolean => {
      const offer = parsePairingInput(text.trim());
      if (!offer) {
        setPasteError("Invalid pairing link or QR payload. Please try again.");
        return false;
      }
      const ok = wsClient.proposePairing(offer);
      if (!ok) {
        setPasteError("Could not initiate pairing with this host endpoint.");
        return false;
      }
      haptic("success");
      onPaired?.();
      onClose();
      return true;
    },
    [onClose, onPaired],
  );

  const handleScanResult = useCallback(
    (text: string) => {
      setScanning(false);
      propose(text);
    },
    [propose],
  );

  return (
    <>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pair-modal-title"
        className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in"
      >
        <div className="w-full max-w-sm rounded-2xl bg-[#17171a] border border-white/[0.12] text-[#fafafa] shadow-2xl p-5 space-y-4">
          <div className="flex items-center justify-between pb-1 border-b border-white/[0.08]">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-[#3276f2]/15 flex items-center justify-center text-[#8ab4f8]">
                <Server className="w-4 h-4" />
              </div>
              <div>
                <h2
                  id="pair-modal-title"
                  className="text-[15px] font-semibold tracking-tight text-[#fafafa]"
                >
                  Pair New Device
                </h2>
                <p className="text-[11.5px] text-[#8e8e93]">
                  Connect another Mac or Linux computer
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="w-8 h-8 rounded-lg hover:bg-white/[0.08] active:bg-white/[0.12] text-[#8e8e93] hover:text-white flex items-center justify-center transition-colors"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="rounded-xl bg-[#0c0c0e] border border-white/[0.08] p-3 space-y-1.5 text-[12px] text-[#a3a3a3]">
            <div className="flex items-center gap-2 font-medium text-[#e5e5e5]">
              <Laptop className="w-3.5 h-3.5 text-[#3276f2]" />
              <span>How to get pairing code:</span>
            </div>
            <p className="leading-relaxed">Open a terminal inside cmux on your computer and run:</p>
            <div className="px-2.5 py-1.5 rounded-lg bg-[#141417] border border-white/[0.06] font-mono text-[11.5px] text-[#8ab4f8] select-all">
              cmob qr --tailscale
            </div>
          </div>

          <div className="space-y-3">
            {canScanQr() && (
              <button
                type="button"
                onClick={() => {
                  haptic("light");
                  setScanning(true);
                }}
                className="w-full h-11 rounded-xl bg-[#3276f2] hover:bg-[#2563eb] active:bg-[#1d4ed8] text-white text-[13.5px] font-semibold flex items-center justify-center gap-2 transition-colors shadow-sm"
              >
                <QrCode className="w-4 h-4" />
                <span>Scan QR with Camera</span>
              </button>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (pasted.trim()) propose(pasted);
              }}
              className="space-y-2 pt-1"
            >
              <label className="text-[12px] font-medium text-[#a3a3a3] block">
                Or paste pairing URL / token:
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={pasted}
                  onChange={(e) => {
                    setPasted(e.target.value);
                    setPasteError(null);
                  }}
                  maxLength={8192}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="https://... or cmux_sec_..."
                  className="flex-1 min-w-0 h-10 bg-[#0c0c0e] border border-white/[0.12] focus:border-[#3276f2] rounded-xl px-3 text-[13px] font-mono text-[#fafafa] placeholder-[#737373] outline-none"
                />
                <button
                  type="submit"
                  disabled={!pasted.trim()}
                  className="h-10 px-4 rounded-xl bg-[#26262b] hover:bg-[#32323a] active:bg-[#3b3b44] disabled:opacity-40 disabled:pointer-events-none text-[13px] font-semibold text-[#fafafa] border border-white/[0.08] transition-colors shrink-0"
                >
                  Pair
                </button>
              </div>
              {pasteError && (
                <p className="text-[11.5px] text-rose-400 leading-tight pt-0.5">{pasteError}</p>
              )}
            </form>
          </div>
        </div>
      </div>

      {scanning && <QrScanModal onResult={handleScanResult} onClose={() => setScanning(false)} />}
    </>
  );
}
