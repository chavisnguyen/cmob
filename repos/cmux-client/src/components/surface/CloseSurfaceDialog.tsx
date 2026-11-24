/**
 * Confirmation dialog before closing a terminal surface
 * Sources:
 * - ref/orca/src/renderer/src/components/editor/model-lifetime/retention/closed-editor-tab-controller.ts
 * - repos/cmux-gateway/src/server.rs:496-519 (mobile.surface.close)
 */

import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

interface CloseSurfaceDialogProps {
  isOpen: boolean;
  surfaceTitle: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

export function CloseSurfaceDialog({
  isOpen,
  surfaceTitle,
  onClose,
  onConfirm,
}: CloseSurfaceDialogProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, loading, onClose]);

  if (!isOpen) return null;

  const handleConfirm = async () => {
    setLoading(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not close the surface.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in"
      onClick={() => {
        if (!loading) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Close Surface"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl bg-bg border border-white/[0.1] text-white shadow-2xl p-4.5 space-y-4"
      >
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-rose-500/15 border border-rose-500/30 text-rose-400 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[16px] font-semibold text-fg">Close Surface?</h3>
            <p className="mt-1 text-[13px] text-muted leading-relaxed">
              Are you sure you want to close{" "}
              <span className="font-semibold text-fg-soft truncate inline-block max-w-[180px] align-bottom">
                &ldquo;{surfaceTitle}&rdquo;
              </span>
              ? Any running process in this terminal will be terminated.
            </p>
          </div>
        </div>

        {error && (
          <p role="alert" className="text-[12.5px] text-rose-300 break-words">
            {error}
          </p>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => {
              setError(null);
              onClose();
            }}
            disabled={loading}
            className="flex-1 h-11 rounded-xl bg-raised hover:bg-line text-[14px] font-semibold text-fg-soft transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading}
            className="flex-1 h-11 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-[14px] font-semibold text-white flex items-center justify-center gap-1.5 shadow-sm transition-colors"
          >
            {loading ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Closing…</span>
              </>
            ) : (
              <span>Close Surface</span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
