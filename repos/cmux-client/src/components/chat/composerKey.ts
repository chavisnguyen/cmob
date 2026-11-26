export const COMPOSITION_END_GUARD_MS = 30;

export interface ComposerKeyInput {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode?: number;
  isDesktop: boolean;
  hasSlashMenu: boolean;
  /** Timestamp (`performance.now()`) of the most recent `compositionend` event (WebKit IME guard). */
  lastCompositionEndAt?: number;
  now?: number;
}

/**
 * On desktop, pressing Enter submits the prompt unless composing (IME, Safari keyCode 229, or within
 * 30ms of WebKit `compositionend`), holding Shift (newline), or navigating the slash-command menu.
 * On mobile, Enter always inserts a newline.
 */
export function shouldSubmitComposerKey({
  key,
  shiftKey,
  isComposing,
  keyCode,
  isDesktop,
  hasSlashMenu,
  lastCompositionEndAt,
  now,
}: ComposerKeyInput): boolean {
  if (isComposing || keyCode === 229) return false;
  if (lastCompositionEndAt !== undefined && lastCompositionEndAt > 0) {
    const currentNow = now ?? (typeof performance !== "undefined" ? performance.now() : 0);
    if (currentNow - lastCompositionEndAt < COMPOSITION_END_GUARD_MS) {
      return false;
    }
  }
  if (!isDesktop || hasSlashMenu) return false;
  return key === "Enter" && !shiftKey;
}
