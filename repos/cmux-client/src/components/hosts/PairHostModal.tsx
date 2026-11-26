import { useCallback, useEffect, useState, type ReactElement } from "react";
import { QrCode, X } from "lucide-react";
import { haptic } from "../../native/haptics";
import { isStaticHostOrigin, parsePairingInput } from "../../protocol/pairing";
import { wsClient } from "../../transport/wsClient";
import { canScanQr } from "./deviceUtils";
import { QrScanModal } from "./QrScanModal";

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
        className="fixed inset-0 z-50 flex items-end md:items-center justify-center md:p-4 bg-black/65 backdrop-blur-[1px] animate-fade-in"
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="pair-modal-title"
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-3xl md:max-w-md mx-auto rounded-t-xl md:rounded-xl bg-surface border-t md:border border-line-strong shadow-2xl pb-[env(safe-area-inset-bottom,0px)] md:pb-0 overflow-hidden"
        >
          <div className="flex items-center justify-between px-4 h-11 bg-sidebar border-b border-line">
            <h2 id="pair-modal-title" className="text-[13.5px] font-semibold text-fg">
              Add a Computer
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="w-7 h-7 rounded-md text-muted hover:text-fg hover:bg-raised flex items-center justify-center"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-4 space-y-4 bg-bg">
            <div className="space-y-1.5">
              <p className="text-[12.5px] text-muted">In a cmux terminal on that Mac, run:</p>
              <code className="block px-3 py-2 rounded-lg bg-sidebar border border-line font-mono text-[12.5px] text-fg select-all">
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
                className="w-full h-9 rounded-lg bg-fg hover:bg-accent-strong text-bg text-[13px] font-medium flex items-center justify-center gap-2 transition-colors"
              >
                <QrCode className="w-3.5 h-3.5" />
                <span>Scan QR Code</span>
              </button>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (pasted.trim()) propose(pasted);
              }}
              className="space-y-1.5"
            >
              <label htmlFor="pair-input" className="text-[12px] text-muted block">
                Or paste pairing link
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
                  className="flex-1 min-w-0 h-9 bg-surface border border-line-strong focus:border-fg/60 rounded-lg px-3 text-[12.5px] font-mono text-fg placeholder-dim outline-none"
                />
                <button
                  type="submit"
                  disabled={!pasted.trim()}
                  className="h-9 px-3.5 rounded-lg bg-fg hover:bg-accent-strong disabled:opacity-40 disabled:pointer-events-none text-[13px] font-medium text-bg transition-colors shrink-0"
                >
                  Pair
                </button>
              </div>
              {pasteError && (
                <p role="alert" className="text-[12px] text-status-err leading-snug">
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
