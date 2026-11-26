import { memo, useMemo } from "react";
import { ChevronDown, ChevronUp, Info } from "lucide-react";
import { useChatDisclosure } from "../../state/useChatDisclosure";
import { planCollapse } from "./collapse";

/** Chat text that folds when long, persisted in `disclosureStore` across virtualizer unmounts. */
export const CollapsibleText = memo(function CollapsibleText({
  text,
  className = "",
  surfaceKey,
  itemKey,
}: {
  text: string;
  className?: string;
  surfaceKey?: string;
  itemKey?: string;
}) {
  const plan = useMemo(() => planCollapse(text), [text]);
  const resolvedKey = itemKey ?? `collapse:${text.length}:${text.slice(0, 48)}`;
  const [open, toggleOpen] = useChatDisclosure(surfaceKey, resolvedKey, false);

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
        onClick={toggleOpen}
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
});
