export interface ComposerKeyInput {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode?: number;
  isDesktop: boolean;
  hasSlashMenu: boolean;
}

/**
 * On desktop, pressing Enter submits the prompt unless composing (IME, including Safari keyCode 229),
 * holding Shift (newline), or navigating the slash-command menu. On mobile, Enter always inserts a newline.
 */
export function shouldSubmitComposerKey({
  key,
  shiftKey,
  isComposing,
  keyCode,
  isDesktop,
  hasSlashMenu,
}: ComposerKeyInput): boolean {
  if (isComposing || keyCode === 229) return false;
  if (!isDesktop || hasSlashMenu) return false;
  return key === "Enter" && !shiftKey;
}
