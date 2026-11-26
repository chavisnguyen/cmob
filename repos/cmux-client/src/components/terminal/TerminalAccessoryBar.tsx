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
      className="bg-bg border-t border-white/[0.08] px-2.5 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] shrink-0 flex items-center gap-2 overflow-x-auto no-scrollbar"
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        onClick={onPasteClipboard}
        className="h-9 px-3 rounded-[10px] bg-raised border border-white/[0.08] text-fg hover:bg-line active:opacity-70 text-[13px] font-sans font-medium shrink-0 flex items-center gap-1.5 transition-opacity"
        title="Paste from clipboard"
      >
        <ClipboardPaste className="w-4 h-4 text-muted" />
        <span>Paste</span>
      </button>

      <button
        type="button"
        onClick={onCtrlTap}
        className={`h-9 min-w-[46px] px-3 rounded-[10px] border text-[13px] font-sans font-semibold shrink-0 transition-opacity active:opacity-70 ${
          ctrlLatch === "locked"
            ? "bg-fg border-fg text-bg"
            : ctrlLatch === "once"
              ? "bg-raised border-fg text-fg"
              : "bg-raised border-transparent text-fg hover:bg-line"
        }`}
        title="Sticky Ctrl (Tap: Once, Double Tap: Lock)"
      >
        {ctrlLatch === "locked" ? "CTRL" : "Ctrl"}
      </button>

      <button
        type="button"
        onClick={onAltTap}
        className={`h-9 min-w-[42px] px-3 rounded-[10px] border text-[13px] font-sans font-semibold shrink-0 transition-opacity active:opacity-70 ${
          altLatch === "locked"
            ? "bg-fg border-fg text-bg"
            : altLatch === "once"
              ? "bg-raised border-fg text-fg"
              : "bg-raised border-transparent text-fg hover:bg-line"
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
            className={`h-9 px-3 rounded-[10px] border text-[13px] font-medium transition-opacity shrink-0 flex items-center justify-center gap-1.5 active:opacity-70 ${
              isActive
                ? "bg-accent border-accent text-white"
                : isSignal
                  ? "bg-[#28181b] border-rose-500/25 text-rose-300 hover:bg-[#341d22]"
                  : "bg-raised border-white/[0.06] text-fg min-w-[38px]"
            }`}
          >
            {Icon && <Icon className="w-4 h-4" />}
            {(!Icon || item.id === "enter") && <span>{item.label}</span>}
          </button>
        );
      })}

      <button
        type="button"
        onClick={onDismissKeyboard}
        className="h-9 w-9 rounded-[10px] bg-raised border border-white/[0.06] text-muted hover:text-fg active:opacity-70 shrink-0 flex items-center justify-center transition-opacity"
        title="Hide keyboard"
        aria-label="Hide keyboard"
      >
        <KeyboardOff className="w-4 h-4" />
      </button>
    </div>
  );
}
