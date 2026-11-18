import { useState, useCallback, useEffect, type ReactElement } from "react";
import { QrCode, X } from "lucide-react";
import { parsePairingInput, isStaticHostOrigin } from "../../protocol/pairing";
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
      const trimmed = text.trim();
      if (
        (trimmed.startsWith("cmux_sec_") || trimmed.startsWith("cmux_dev_")) &&
        typeof window !== "undefined" &&
        isStaticHostOrigin(window.location)
      ) {
        setPasteError(
          "On GitHub Pages, please paste the full pairing link (https://...#code=...) or scan the QR code.",
        );
        return false;
      }
      const offer = parsePairingInput(trimmed);
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
        className="fixed inset-0 z-50 flex items-end bg-black/60 animate-fade-in"
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="pair-modal-title"
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-3xl mx-auto rounded-t-2xl bg-bg border-t border-white/[0.1] shadow-2xl pb-[env(safe-area-inset-bottom,0px)]"
        >
          <div className="flex items-center justify-between px-4 h-12 border-b border-white/[0.08]">
            <h2 id="pair-modal-title" className="text-[15px] font-semibold">
              Add a computer
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="w-9 h-9 rounded-xl text-muted hover:bg-raised flex items-center justify-center"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="px-4 py-4 space-y-5">
            <div className="space-y-2">
              <p className="text-[13.5px] text-muted">In a cmux terminal on that computer, run:</p>
              <code className="block px-3 py-2.5 rounded-xl bg-surface font-mono text-[13px] text-fg select-all">
                cmob qr --tailscale
              </code>
            </div>

            {canScanQr() && (
              <button
                type="button"
                onClick={() => {
                  haptic("light");
                  setScanning(true);
                }}
                className="w-full h-11 rounded-xl bg-accent hover:bg-accent-strong text-white text-[14px] font-semibold flex items-center justify-center gap-2 transition-colors"
              >
                <QrCode className="w-4 h-4" />
                <span>Scan the QR code</span>
              </button>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (pasted.trim()) propose(pasted);
              }}
              className="space-y-2"
            >
              <label htmlFor="pair-input" className="text-[13px] text-muted block">
                Or paste the pairing link
              </label>
              <div className="flex gap-2">
                <input
                  id="pair-input"
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
                  placeholder="https://… or cmux_sec_…"
                  className="flex-1 min-w-0 h-11 bg-surface border border-line focus:border-accent rounded-xl px-3 text-[13px] font-mono text-fg placeholder-dim outline-none"
                />
                <button
                  type="submit"
                  disabled={!pasted.trim()}
                  className="h-11 px-4 rounded-xl bg-raised hover:bg-line disabled:opacity-40 disabled:pointer-events-none text-[14px] font-semibold text-fg transition-colors shrink-0"
                >
                  Pair
                </button>
              </div>
              {pasteError && (
                <p role="alert" className="text-[12.5px] text-rose-300 leading-snug">
                  {pasteError}
                </p>
              )}
            </form>
          </div>
        </div>
      </div>

      {scanning && <QrScanModal onResult={handleScanResult} onClose={() => setScanning(false)} />}
    </>
  );
}
