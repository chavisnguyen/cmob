import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";

interface RenameSurfaceModalProps {
  isOpen: boolean;
  currentTitle: string;
  onClose: () => void;
  onRename: (nextTitle: string) => Promise<void>;
}

export function RenameSurfaceModal({
  isOpen,
  currentTitle,
  onClose,
  onRename,
}: RenameSurfaceModalProps) {
  const [title, setTitle] = useState(currentTitle);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setTitle(currentTitle);
      setError(null);
    }
  }, [isOpen, currentTitle]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, loading, onClose]);

  if (!isOpen) return null;

  const trimmed = title.trim();

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!trimmed) {
      setError("Tab name cannot be empty");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await onRename(trimmed);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to rename tab");
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
        aria-label="Rename Tab"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl bg-surface border border-line-strong text-fg shadow-2xl overflow-hidden flex flex-col"
      >
        <div className="flex items-center justify-between px-4 h-11 border-b border-line bg-sidebar">
          <h2 className="text-[13.5px] font-semibold text-fg">Rename Tab</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="w-7 h-7 rounded-md text-muted hover:text-fg hover:bg-raised flex items-center justify-center transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-3.5 bg-bg">
          {error && (
            <div className="px-2.5 py-1.5 rounded-md bg-status-err/10 border border-status-err/30 text-status-err text-[12px]">
              {error}
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-muted uppercase tracking-wider">
              Tab Name
            </label>
            <input
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="e.g. build logs"
              autoFocus
              className="w-full h-9 bg-surface border border-line-strong focus:border-fg/60 rounded-lg px-3 text-[13.5px] text-fg placeholder-dim outline-none"
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex-1 h-9 rounded-lg bg-raised hover:bg-line-strong text-[13px] font-medium text-fg-soft transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !trimmed}
              className="flex-1 h-9 rounded-lg bg-fg hover:bg-accent-strong disabled:opacity-50 text-[13px] font-medium text-bg flex items-center justify-center gap-1.5 transition-colors"
            >
              {loading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Saving…</span>
                </>
              ) : (
                <span>Save</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
