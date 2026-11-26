import React from "react";
import { ArrowDown } from "lucide-react";

export function NativeChatJumpToLatest({
  visible,
  onJump,
}: {
  visible: boolean;
  onJump: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-shown={visible}
      tabIndex={visible ? 0 : -1}
      aria-hidden={!visible}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onJump}
      aria-label="Jump to latest message"
      className={`absolute bottom-3 right-4 lg:right-8 flex h-8 w-8 items-center justify-center rounded-full border border-line-strong bg-surface/95 text-muted shadow-md transition-all duration-150 ease-out hover:bg-raised hover:text-fg z-30 ${
        visible
          ? "opacity-100 translate-y-0 pointer-events-auto"
          : "opacity-0 translate-y-2 pointer-events-none"
      }`}
    >
      <ArrowDown className="w-3.5 h-3.5" />
    </button>
  );
}
