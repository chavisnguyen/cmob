import { useEffect, useState } from "react";
import { Pencil, X, Loader2 } from "lucide-react";

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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-sm rounded-2xl bg-[#171717] border border-white/[0.1] text-white shadow-2xl overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.08] bg-[#141416]">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-[#3276f2]/15 text-[#8ab4f8] flex items-center justify-center">
              <Pencil className="w-3.5 h-3.5" />
            </div>
            <h2 className="text-[16px] font-semibold text-[#fafafa]">Rename Tab</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-[#252735] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {error && (
            <div className="p-2 rounded bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs">
              {error}
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-[12px] font-semibold text-[#a3a3a3] uppercase tracking-wider">
              Tab Name
            </label>
            <input
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="e.g. build logs"
              autoFocus
              className="w-full h-11 bg-[#0a0a0a] border border-white/[0.14] focus:border-[#3276f2] rounded-xl px-3.5 text-[15px] text-white placeholder-gray-600 outline-none"
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex-1 h-11 rounded-xl bg-[#262626] hover:bg-[#303036] text-[14px] font-semibold text-gray-300 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !trimmed}
              className="flex-1 h-11 rounded-xl bg-[#3276f2] hover:bg-[#2563eb] disabled:opacity-50 text-[14px] font-semibold text-white flex items-center justify-center gap-1.5 shadow-sm transition-colors"
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
