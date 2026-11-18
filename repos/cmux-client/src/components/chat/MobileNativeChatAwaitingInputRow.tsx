import { useState } from "react";
import { HelpCircle, Check, Send, X } from "lucide-react";
import type { AwaitingInput } from "../../protocol/event";

interface MobileNativeChatAwaitingInputRowProps {
  awaiting: AwaitingInput;
  onSubmit: (response: string) => Promise<void>;
  onCancel?: () => Promise<void>;
}

export function MobileNativeChatAwaitingInputRow({
  awaiting,
  onSubmit,
  onCancel,
}: MobileNativeChatAwaitingInputRowProps) {
  const [selectedIndices, setSelectedIndices] = useState<number[]>([]);
  const [otherText, setOtherText] = useState("");
  const [isOtherSelected, setIsOtherSelected] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const options = awaiting.options || [];
  const isMulti = awaiting.multi_select === true;

  const toggleOption = (idx: number) => {
    if (isMulti) {
      setSelectedIndices((prev) =>
        prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx],
      );
    } else {
      setSelectedIndices([idx]);
      setIsOtherSelected(false);
    }
  };

  const handleSelectOther = () => {
    if (isMulti) {
      setIsOtherSelected((prev) => !prev);
    } else {
      setIsOtherSelected(true);
      setSelectedIndices([]);
    }
  };

  const handleSubmit = async () => {
    if (isSubmitting) return;

    let response = "";
    if (isOtherSelected && otherText.trim()) {
      response = otherText.trim();
    } else if (selectedIndices.length > 0) {
      const selectedLabels = selectedIndices.map((i) => options[i]).filter(Boolean);
      response = selectedLabels.join(", ");
    } else if (options.length === 0 && otherText.trim()) {
      response = otherText.trim();
    }

    if (!response) return;

    setIsSubmitting(true);
    try {
      await onSubmit(response);
    } finally {
      setIsSubmitting(false);
    }
  };

  const hasSelection =
    selectedIndices.length > 0 || (isOtherSelected && otherText.trim().length > 0);

  return (
    <div className="w-full my-3 rounded-2xl border-2 border-accent/40 bg-surface shadow-lg overflow-hidden text-xs">
      {/* Header */}
      <div className="px-4 py-3 bg-accent/10 border-b border-accent/20 flex items-start gap-2.5">
        <HelpCircle className="w-4 h-4 text-accent-soft shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <span className="text-[10px] uppercase font-bold tracking-wider text-accent-soft">
            Awaiting Your Input
          </span>
          <p className="text-sm font-semibold text-white mt-0.5 leading-snug">{awaiting.prompt}</p>
        </div>
      </div>

      {/* Options List */}
      <div className="p-3 space-y-2">
        {options.map((opt, idx) => {
          const isSelected = selectedIndices.includes(idx);
          return (
            <button
              key={`opt-${idx}`}
              type="button"
              onClick={() => toggleOption(idx)}
              className={`w-full flex items-center justify-between p-3 rounded-xl border text-left transition-all ${
                isSelected
                  ? "bg-accent/20 border-accent text-white shadow-sm"
                  : "bg-surface border-line text-fg-soft hover:bg-surface"
              }`}
            >
              <span className="text-xs font-medium pr-2">{opt}</span>
              <div
                className={`w-4 h-4 rounded-md flex items-center justify-center border shrink-0 transition-colors ${
                  isSelected
                    ? "bg-accent border-accent text-white"
                    : "border-gray-600 bg-transparent"
                }`}
              >
                {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
              </div>
            </button>
          );
        })}

        {/* "Other..." option */}
        <div className="space-y-2">
          {options.length > 0 && (
            <button
              type="button"
              onClick={handleSelectOther}
              className={`w-full flex items-center justify-between p-2.5 rounded-xl border text-left transition-all ${
                isOtherSelected
                  ? "bg-accent/20 border-accent text-white"
                  : "bg-surface border-line text-muted hover:bg-surface"
              }`}
            >
              <span className="text-xs font-medium">Other answer…</span>
              <div
                className={`w-4 h-4 rounded-md flex items-center justify-center border shrink-0 ${
                  isOtherSelected
                    ? "bg-accent border-accent text-white"
                    : "border-gray-600 bg-transparent"
                }`}
              >
                {isOtherSelected && <Check className="w-3 h-3 stroke-[3]" />}
              </div>
            </button>
          )}

          {(isOtherSelected || options.length === 0) && (
            <div className="pt-1">
              <textarea
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                placeholder="Type your response here..."
                rows={2}
                className="w-full bg-bg border border-accent/40 rounded-xl p-2.5 text-xs text-white placeholder-dim focus:outline-none focus:border-accent-soft resize-none font-sans"
              />
            </div>
          )}
        </div>
      </div>

      {/* Action Footer */}
      <div className="px-4 py-2.5 bg-surface border-t border-line flex items-center justify-between gap-2">
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg text-muted hover:text-white transition-colors flex items-center gap-1 font-medium"
          >
            <X className="w-3.5 h-3.5" />
            <span>Cancel</span>
          </button>
        ) : (
          <div />
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={!hasSelection || isSubmitting}
          className="px-4 py-2 rounded-xl bg-accent hover:bg-accent active:bg-accent disabled:opacity-40 text-white font-semibold flex items-center gap-1.5 transition-colors shadow-sm ml-auto"
        >
          <Send className="w-3.5 h-3.5" />
          <span>{isSubmitting ? "Sending..." : "Submit Answer"}</span>
        </button>
      </div>
    </div>
  );
}
