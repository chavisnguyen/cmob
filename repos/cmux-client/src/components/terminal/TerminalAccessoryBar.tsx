import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardPaste,
  CornerDownLeft,
  KeyboardOff,
} from "lucide-react";
import type { StickyModifierLatch } from "../../domain/terminalState";
import type { TerminalKeyActionItem } from "../../state/useTerminalController";

interface TerminalKeyItem extends TerminalKeyActionItem {
  label: string;
  icon?: typeof ArrowUp;
  category?: "nav" | "symbol" | "signal";
}

const EXTENDED_KEYS: TerminalKeyItem[] = [
  { id: "esc", label: "Esc", key: "escape" },
  { id: "tab", label: "Tab", key: "tab" },
  { id: "shiftTab", label: "⇧Tab", key: "shift+tab" },
  { id: "enter", label: "Enter", key: "enter", icon: CornerDownLeft },
  { id: "up", label: "↑", key: "up", icon: ArrowUp, category: "nav" },
  { id: "down", label: "↓", key: "down", icon: ArrowDown, category: "nav" },
  { id: "left", label: "←", key: "left", icon: ArrowLeft, category: "nav" },
  { id: "right", label: "→", key: "right", icon: ArrowRight, category: "nav" },
  { id: "pipe", label: "|", text: "|", category: "symbol" },
  { id: "slash", label: "/", text: "/", category: "symbol" },
  { id: "tilde", label: "~", text: "~", category: "symbol" },
  { id: "backtick", label: "`", text: "`", category: "symbol" },
  { id: "dash", label: "-", text: "-", category: "symbol" },
  { id: "underscore", label: "_", text: "_", category: "symbol" },
  { id: "ctrlC", label: "^C", key: "ctrl+c", category: "signal" },
  { id: "ctrlD", label: "^D", key: "ctrl+d", category: "signal" },
  { id: "ctrlZ", label: "^Z", key: "ctrl+z", category: "signal" },
  { id: "ctrlL", label: "^L", key: "ctrl+l", category: "signal" },
  { id: "ctrlR", label: "^R", key: "ctrl+r", category: "signal" },
];

export function TerminalAccessoryBar({
  ctrlLatch,
  altLatch,
  activeKey,
  onPasteClipboard,
  onCtrlTap,
  onAltTap,
  onKeyPress,
  onDismissKeyboard,
}: {
  ctrlLatch: StickyModifierLatch;
  altLatch: StickyModifierLatch;
  activeKey: string | null;
  onPasteClipboard: () => void;
  onCtrlTap: () => void;
  onAltTap: () => void;
  onKeyPress: (item: TerminalKeyActionItem) => void;
  onDismissKeyboard: () => void;
}) {
  return (
    <div
      className="bg-sidebar border-t border-line px-2 pt-1.5 pb-[calc(0.4rem+env(safe-area-inset-bottom,0px))] shrink-0 flex items-center gap-1.5 overflow-x-auto no-scrollbar"
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        onClick={onPasteClipboard}
        className="h-8 px-2.5 rounded-md bg-surface border border-line text-fg-soft hover:text-fg hover:bg-raised active:opacity-70 text-[12px] font-sans font-medium shrink-0 flex items-center gap-1.5 transition-colors"
        title="Paste from clipboard"
      >
        <ClipboardPaste className="w-3.5 h-3.5 text-muted" />
        <span>Paste</span>
      </button>

      <button
        type="button"
        onClick={onCtrlTap}
        className={`h-8 min-w-[42px] px-2.5 rounded-md border text-[12px] font-sans font-semibold shrink-0 transition-colors active:opacity-70 ${
          ctrlLatch === "locked"
            ? "bg-fg border-fg text-bg"
            : ctrlLatch === "once"
              ? "bg-raised border-fg/60 text-fg"
              : "bg-surface border-line text-fg-soft hover:bg-raised"
        }`}
        title="Sticky Ctrl (Tap: Once, Double Tap: Lock)"
      >
        {ctrlLatch === "locked" ? "CTRL" : "Ctrl"}
      </button>

      <button
        type="button"
        onClick={onAltTap}
        className={`h-8 min-w-[40px] px-2.5 rounded-md border text-[12px] font-sans font-semibold shrink-0 transition-colors active:opacity-70 ${
          altLatch === "locked"
            ? "bg-fg border-fg text-bg"
            : altLatch === "once"
              ? "bg-raised border-fg/60 text-fg"
              : "bg-surface border-line text-fg-soft hover:bg-raised"
        }`}
        title="Sticky Alt/Meta (Tap: Once, Double Tap: Lock)"
      >
        {altLatch === "locked" ? "ALT" : "Alt"}
      </button>

      {EXTENDED_KEYS.map((item) => {
        const Icon = item.icon;
        const isSignal = item.category === "signal";
        const isActive = activeKey === item.id;

        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onKeyPress(item)}
            className={`h-8 px-2.5 rounded-md border text-[12px] font-mono font-medium transition-colors shrink-0 flex items-center justify-center gap-1 active:opacity-70 ${
              isActive
                ? "bg-fg border-fg text-bg"
                : isSignal
                  ? "bg-status-err/10 border-status-err/25 text-status-err hover:bg-status-err/15"
                  : "bg-surface border-line text-fg-soft hover:text-fg hover:bg-raised min-w-[34px]"
            }`}
          >
            {Icon && <Icon className="w-3.5 h-3.5" />}
            {(!Icon || item.id === "enter") && <span>{item.label}</span>}
          </button>
        );
      })}

      <button
        type="button"
        onClick={onDismissKeyboard}
        className="h-8 w-8 rounded-md bg-surface border border-line text-muted hover:text-fg hover:bg-raised active:opacity-70 shrink-0 flex items-center justify-center transition-colors"
        title="Hide keyboard"
        aria-label="Hide keyboard"
      >
        <KeyboardOff className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
