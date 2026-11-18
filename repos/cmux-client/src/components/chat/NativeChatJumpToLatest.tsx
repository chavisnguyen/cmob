import React from "react";
import { ArrowDown } from "lucide-react";

/**
 * Orca-style Jump to Latest Floating Pill
 * Matches: ref/orca/src/renderer/src/components/native-chat/viewport/scroll/NativeChatJumpToLatest.tsx
 * - Kept mounted for smooth opacity/translate transitions.
 * - Prevents default on mouseDown to keep typing focus intact in the composer.
 */
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
      className={`absolute bottom-3 right-3 flex h-10 w-10 items-center justify-center rounded-full border border-line bg-raised text-fg-soft shadow-lg transition-all duration-200 ease-out hover:bg-raised hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent z-30 ${
        visible
          ? "opacity-100 translate-y-0 pointer-events-auto"
          : "opacity-0 translate-y-2 pointer-events-none"
      }`}
    >
      <ArrowDown className="w-4 h-4 text-accent-soft" />
    </button>
  );
}
