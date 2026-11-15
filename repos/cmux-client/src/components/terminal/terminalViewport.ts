export type TerminalViewportMode = "mobile" | "desktop";
export type StickyModifierLatch = "off" | "once" | "locked";

export interface GridDimensions {
  cols: number;
  rows: number;
}

export interface MobileGridInput {
  viewportWidth: number;
  viewportHeight: number;
  cellWidth: number;
  cellHeight: number;
  minCols?: number;
  minRows?: number;
}

export interface DesktopFitInput {
  viewportWidth: number;
  cols: number;
  cellWidth: number;
  scrollWidth?: number;
}

export interface DesktopPanInput {
  panX: number;
  panY: number;
  contentWidth: number;
  contentHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  totalScale: number;
}

export function transitionStickyLatch(
  current: StickyModifierLatch,
  isDoubleTap: boolean,
): StickyModifierLatch {
  if (isDoubleTap) return "locked";
  if (current === "off") return "once";
  return "off";
}

export function consumeStickyLatch(current: StickyModifierLatch): StickyModifierLatch {
  return current === "once" ? "off" : current;
}

export function computeMobileGridDimensions({
  viewportWidth,
  viewportHeight,
  cellWidth,
  cellHeight,
  minCols = 20,
  minRows = 8,
}: MobileGridInput): GridDimensions {
  if (
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    !Number.isFinite(cellWidth) ||
    !Number.isFinite(cellHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0 ||
    cellWidth <= 0 ||
    cellHeight <= 0
  ) {
    return { cols: 45, rows: 24 };
  }
  const cols = Math.max(minCols, Math.floor(viewportWidth / cellWidth));
  const rows = Math.max(minRows, Math.floor(viewportHeight / cellHeight));
  return { cols, rows };
}

export function computeDesktopFitScale({
  viewportWidth,
  cols,
  cellWidth,
  scrollWidth = 0,
}: DesktopFitInput): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return 1;
  }
  const termWidth = cellWidth > 0 && cols > 0 ? cellWidth * cols : scrollWidth;
  if (!Number.isFinite(termWidth) || termWidth <= 0) {
    return 1;
  }
  const rawScale = Math.min(1, viewportWidth / termWidth);
  return rawScale >= 0.95 ? 1 : rawScale;
}

export function clampDesktopPan({
  panX,
  panY,
  contentWidth,
  contentHeight,
  viewportWidth,
  viewportHeight,
  totalScale,
}: DesktopPanInput): { panX: number; panY: number } {
  const scaledWidth = contentWidth * totalScale;
  const scaledHeight = contentHeight * totalScale;
  const clampedX =
    scaledWidth > viewportWidth ? Math.min(0, Math.max(viewportWidth - scaledWidth, panX)) : 0;
  const clampedY =
    scaledHeight > viewportHeight ? Math.min(0, Math.max(viewportHeight - scaledHeight, panY)) : 0;
  return { panX: clampedX, panY: clampedY };
}

export function encodeAccessoryKey(keyId: string, applicationCursorKeysMode = false): string {
  switch (keyId) {
    case "escape":
      return "\x1b";
    case "tab":
      return "\t";
    case "shift+tab":
      return "\x1b[Z";
    case "enter":
      return "\r";
    case "up":
      return applicationCursorKeysMode ? "\x1bOA" : "\x1b[A";
    case "down":
      return applicationCursorKeysMode ? "\x1bOB" : "\x1b[B";
    case "right":
      return applicationCursorKeysMode ? "\x1bOC" : "\x1b[C";
    case "left":
      return applicationCursorKeysMode ? "\x1bOD" : "\x1b[D";
    case "ctrl+c":
      return "\x03";
    case "ctrl+d":
      return "\x04";
    case "ctrl+z":
      return "\x1a";
    case "ctrl+l":
      return "\x0c";
    case "ctrl+r":
      return "\x12";
    default:
      return "";
  }
}

function encodeCtrlChar(char: string): string | null {
  if (char.length !== 1) return null;
  const lower = char.toLowerCase();
  const code = lower.charCodeAt(0);
  if (code >= 97 && code <= 122) {
    return String.fromCharCode(code - 96);
  }
  switch (char) {
    case "@":
    case " ":
      return "\x00";
    case "[":
      return "\x1b";
    case "\\":
      return "\x1c";
    case "]":
      return "\x1d";
    case "^":
      return "\x1e";
    case "_":
      return "\x1f";
    case "?":
      return "\x7f";
    default:
      return null;
  }
}

export function applyStickyModifiersToText(
  text: string,
  ctrlLatch: StickyModifierLatch,
  altLatch: StickyModifierLatch,
): string {
  let bytes = text;
  if (ctrlLatch !== "off" && text.length === 1) {
    const ctrlByte = encodeCtrlChar(text);
    if (ctrlByte !== null) {
      bytes = ctrlByte;
    }
  }
  if (altLatch !== "off" && bytes.length > 0) {
    bytes = `\x1b${bytes}`;
  }
  return bytes;
}

export function getOrCreateTerminalClientId(): string {
  const storageKey = "cmux_terminal_client_id";
  try {
    const existing = localStorage.getItem(storageKey);
    if (existing && existing.trim().length > 0) {
      return existing;
    }
    const created = `pwa-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(storageKey, created);
    return created;
  } catch {
    return "pwa-default";
  }
}
