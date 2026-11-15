import type { HTMLAttributes, KeyboardEvent, ReactNode } from "react";

interface PressableProps extends Omit<HTMLAttributes<HTMLDivElement>, "onClick"> {
  onPress: () => void;
  children: ReactNode;
}

/**
 * Clickable container that is not a <button> (e.g. a row that contains nested buttons, which a
 * <button> cannot). Adds button semantics + keyboard activation, and `data-haptic` so the global
 * haptics layer (src/native/haptics.ts) gives it tap feedback like a real button.
 * Prefer a plain <button> whenever the content has no nested interactive elements.
 */
export function Pressable({ onPress, children, onKeyDown, ...rest }: PressableProps) {
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented || e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onPress();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      data-haptic=""
      onClick={onPress}
      onKeyDown={handleKeyDown}
      {...rest}
    >
      {children}
    </div>
  );
}
