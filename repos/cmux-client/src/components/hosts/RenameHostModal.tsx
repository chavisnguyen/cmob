import { useEffect, useState, type ReactElement } from "react";
import { Pencil, X } from "lucide-react";
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
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in"
    >
      <div className="w-full max-w-sm rounded-2xl bg-[#17171a] border border-white/[0.12] text-[#fafafa] shadow-2xl p-5 space-y-4">
        <div className="flex items-center justify-between pb-1 border-b border-white/[0.08]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-white/[0.08] flex items-center justify-center text-[#e5e5e5]">
              <Pencil className="w-4 h-4" />
            </div>
            <div>
              <h2
                id="rename-modal-title"
                className="text-[15px] font-semibold tracking-tight text-[#fafafa]"
              >
                Rename Device
              </h2>
              <p className="text-[11.5px] text-[#8e8e93] font-mono truncate max-w-[200px]">
                {host.endpoint}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg hover:bg-white/[0.08] text-[#8e8e93] hover:text-white flex items-center justify-center transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-[#a3a3a3]">Device Name</label>
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
              className="w-full h-11 bg-[#0c0c0e] border border-white/[0.12] focus:border-[#3276f2] rounded-xl px-3.5 text-[14px] text-[#fafafa] placeholder-[#737373] outline-none"
            />
          </div>

          <div className="flex items-center gap-2.5 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 h-11 rounded-xl bg-[#242429] hover:bg-[#2e2e34] text-[13.5px] font-medium text-[#d4d4d8] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!sanitizeHostName(name) || sanitizeHostName(name) === host.name}
              className="flex-1 h-11 rounded-xl bg-[#3276f2] hover:bg-[#2563eb] disabled:opacity-40 disabled:pointer-events-none text-[13.5px] font-semibold text-white transition-colors"
            >
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
