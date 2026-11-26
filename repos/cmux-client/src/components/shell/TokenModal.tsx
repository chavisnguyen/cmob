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
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm p-5 rounded-2xl bg-bg border border-white/[0.1] text-fg shadow-2xl space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[16px] font-semibold flex items-center gap-2.5">
          <KeyRound className="w-5 h-5 text-accent-soft" />
          <span>Gateway Auth Token</span>
        </h2>
        <p className="text-[13px] text-muted leading-relaxed">
          Enter the bearer token printed in your cmux-gateway terminal or scanned from the QR code.
        </p>
        <input
          type="password"
          value={tokenInput}
          onChange={(e) => onChangeToken(e.target.value)}
          placeholder="cmux_sec_..."
          className="w-full h-11 bg-bg border border-white/[0.14] focus:border-accent rounded-xl px-3.5 text-[15px] font-mono text-fg placeholder-dim outline-none"
        />
        <div className="flex items-center gap-2.5 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 h-11 rounded-xl bg-raised hover:bg-line text-[14px] font-semibold text-fg-soft transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            className="flex-1 h-11 rounded-xl bg-accent hover:bg-accent-strong text-[14px] font-semibold text-white transition-colors"
          >
            Save &amp; Connect
          </button>
        </div>
      </div>
    </div>
  );
}
