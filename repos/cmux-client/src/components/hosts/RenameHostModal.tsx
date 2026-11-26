import { useEffect, useState, type ReactElement } from "react";
import { X } from "lucide-react";
import { sanitizeHostName, type SavedHost } from "../../hosts/hostStore";
import { haptic } from "../../native/haptics";

export function RenameHostModal({
  host,
  onRename,
  onClose,
}: {
  host: SavedHost;
  onRename: (newName: string) => void;
  onClose: () => void;
}): ReactElement {
  const [name, setName] = useState(host.name);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const sanitized = sanitizeHostName(name);
    if (!sanitized) return;
    haptic("light");
    onRename(sanitized);
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="rename-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/65 backdrop-blur-[1px] animate-fade-in"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl bg-surface border border-line-strong text-fg shadow-2xl overflow-hidden flex flex-col"
      >
        <div className="flex items-center justify-between px-4 h-11 bg-sidebar border-b border-line">
          <div className="min-w-0">
            <h2 id="rename-modal-title" className="text-[13.5px] font-semibold text-fg">
              Rename Computer
            </h2>
            <p className="text-[11px] text-dim font-mono truncate max-w-[240px]">{host.endpoint}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 rounded-md hover:bg-raised text-muted hover:text-fg flex items-center justify-center transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-3.5 bg-bg">
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              Display Name
            </label>
            <input
              type="text"
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Work MacBook, Mac Studio"
              maxLength={40}
              className="w-full h-9 bg-surface border border-line-strong focus:border-fg/60 rounded-lg px-3 text-[13.5px] text-fg placeholder-dim outline-none"
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 h-9 rounded-lg bg-raised hover:bg-line-strong text-[13px] font-medium text-fg-soft transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!sanitizeHostName(name) || sanitizeHostName(name) === host.name}
              className="flex-1 h-9 rounded-lg bg-fg hover:bg-accent-strong disabled:opacity-40 disabled:pointer-events-none text-[13px] font-medium text-bg transition-colors"
            >
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
