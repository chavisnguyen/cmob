import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

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
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/65 backdrop-blur-[1px] animate-fade-in"
      onClick={() => {
        if (!loading) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Close Surface"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl bg-surface border border-line-strong text-fg shadow-2xl p-4 space-y-3.5"
      >
        <div>
          <h3 className="text-[14.5px] font-semibold text-fg">Close Tab?</h3>
          <p className="mt-1 text-[12.5px] text-muted leading-relaxed">
            Close{" "}
            <span className="font-medium text-fg truncate inline-block max-w-[190px] align-bottom">
              &ldquo;{surfaceTitle}&rdquo;
            </span>
            ? Any running process in this terminal will be terminated.
          </p>
        </div>

        {error && (
          <p role="alert" className="text-[12px] text-status-err break-words">
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
            className="flex-1 h-9 rounded-lg bg-raised hover:bg-line-strong text-[13px] font-medium text-fg-soft transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading}
            className="flex-1 h-9 rounded-lg bg-status-err hover:opacity-90 disabled:opacity-50 text-[13px] font-medium text-white flex items-center justify-center gap-1.5 transition-opacity"
          >
            {loading ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Closing…</span>
              </>
            ) : (
              <span>Close Tab</span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
