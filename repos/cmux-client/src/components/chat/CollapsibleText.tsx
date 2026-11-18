import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Info } from "lucide-react";
import { planCollapse } from "./collapse";

/** Chat text that folds when long, so one message cannot push the rest of the conversation off a phone screen. */
export function CollapsibleText({ text, className = "" }: { text: string; className?: string }) {
  const plan = useMemo(() => planCollapse(text), [text]);
  const [open, setOpen] = useState(false);

  if (!plan.collapsible) {
    return <p className={className}>{plan.preview}</p>;
  }

  const shown = open ? text.trim() : plan.preview;
  return (
    <div className="min-w-0">
      {plan.injected && (
        <div className="flex items-center gap-1 mb-1 text-[11px] uppercase tracking-wider text-dim font-semibold">
          <Info className="w-3 h-3" aria-hidden="true" />
          <span>System message</span>
        </div>
      )}
      <p className={`${className} ${plan.injected ? "text-muted" : ""}`}>
        {shown}
        {!open && "…"}
      </p>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="mt-1.5 inline-flex items-center gap-1 min-h-[32px] text-[12.5px] font-medium text-accent-soft active:opacity-70"
      >
        {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        <span>
          {open
            ? "Show less"
            : plan.hiddenLines > 0
              ? `Show more · ${plan.hiddenLines} lines`
              : "Show more"}
        </span>
      </button>
    </div>
  );
}
