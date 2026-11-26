import { KeyRound } from "lucide-react";

export function TokenModal({
  tokenInput,
  onChangeToken,
  onSave,
  onClose,
}: {
  tokenInput: string;
  onChangeToken: (value: string) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/65 backdrop-blur-[1px]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm p-4 rounded-xl bg-surface border border-line-strong text-fg shadow-2xl space-y-3.5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[14.5px] font-semibold flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-muted" />
          <span>Gateway Auth Token</span>
        </h2>
        <p className="text-[12.5px] text-muted leading-relaxed">
          Enter the bearer token printed in your cmob terminal or scanned from the QR code.
        </p>
        <input
          type="password"
          value={tokenInput}
          onChange={(e) => onChangeToken(e.target.value)}
          placeholder="cmux_sec_..."
          className="w-full h-9 bg-bg border border-line-strong focus:border-fg/60 rounded-lg px-3 text-[13.5px] font-mono text-fg placeholder-dim outline-none"
        />
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 h-9 rounded-lg bg-raised hover:bg-line-strong text-[13px] font-medium text-fg-soft transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            className="flex-1 h-9 rounded-lg bg-fg hover:bg-accent-strong text-[13px] font-medium text-bg transition-colors"
          >
            Save &amp; Connect
          </button>
        </div>
      </div>
    </div>
  );
}
