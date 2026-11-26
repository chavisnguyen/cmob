import type { RenderGridData, RenderGridSpan, TerminalReplayPayload } from "../protocol/rpc";

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

export function viewportStorageKey(isDesktop: boolean): string {
  return isDesktop ? "cmux_terminal_viewport_mode_desktop" : "cmux_terminal_viewport_mode";
}

export function resolveDefaultViewportMode(isDesktop: boolean): TerminalViewportMode {
  return isDesktop ? "desktop" : "mobile";
}

export function loadSavedViewportMode(
  isDesktop: boolean,
  storage?: Pick<Storage, "getItem"> | null,
): TerminalViewportMode {
  const fallback = resolveDefaultViewportMode(isDesktop);
  const store =
    storage !== undefined ? storage : typeof localStorage !== "undefined" ? localStorage : null;
  if (!store) return fallback;
  try {
    const saved = store.getItem(viewportStorageKey(isDesktop));
    if (saved === "desktop" || saved === "mobile") {
      return saved;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

function hashSpansFnv1a(spans: readonly RenderGridSpan[] | undefined): number {
  if (!spans || spans.length === 0) return 0;
  let hash = 0x811c9dc5;
  for (let i = 0; i < spans.length; i += 1) {
    const s = spans[i];
    hash ^= s.row;
    hash = Math.imul(hash, 0x01000193);
    hash ^= s.column;
    hash = Math.imul(hash, 0x01000193);
    hash ^= s.style_id;
    hash = Math.imul(hash, 0x01000193);
    for (let c = 0; c < s.text.length; c += 1) {
      hash ^= s.text.charCodeAt(c);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return hash >>> 0;
}

/**
 * Full render-grid fingerprint matching gateway `terminal_replay_fingerprint`
 * (`server.rs:1167-1184`), extended with cursor style/blinking, private modes, and a fast
 * FNV-1a span digest so cursor moves, scrollback growth, or static-revision grids are never dropped.
 */
export function computeRenderGridFingerprint(
  grid: RenderGridData,
  payload?: Pick<TerminalReplayPayload, "mode" | "size_state">,
): string {
  const mode = payload?.mode ?? "";
  const epoch = grid.render_epoch ?? "";
  const rev = grid.render_revision ?? 0;
  const rowRev = grid.row_space_revision ?? 0;
  const stateSeq = grid.state_seq ?? 0;
  const cols = grid.columns || 0;
  const rows = grid.rows || 0;
  const screen = grid.active_screen ?? "";
  const sbRows = grid.scrollback_rows ?? 0;
  const histRows = grid.history_rows ?? 0;

  const cursorRow = grid.cursor?.row ?? 0;
  const cursorCol = grid.cursor?.column ?? 0;
  const cursorVis = grid.cursor?.visible !== false;
  const cursorStyle = grid.cursor?.style ?? "block";
  const cursorBlink = Boolean(grid.cursor?.blinking);

  const ssCols = payload?.size_state?.cols ?? 0;
  const ssRows = payload?.size_state?.rows ?? 0;

  const activeModes = (grid.modes ?? [])
    .filter((m) => !m.ansi && m.on)
    .map((m) => m.code)
    .join(",");

  const rowHash = hashSpansFnv1a(grid.row_spans);
  const sbHash = hashSpansFnv1a(grid.scrollback_spans);

  return `${mode}|${epoch}|${rev}|${rowRev}|${stateSeq}|${cols}x${rows}|${screen}|${sbRows}:${histRows}|${cursorRow},${cursorCol},${cursorVis},${cursorStyle},${cursorBlink}|${ssCols}x${ssRows}|${activeModes}|${rowHash}:${sbHash}`;
}

export function normalizeWheelDeltaPx(
  deltaY: number,
  deltaMode: number,
  pxPerLine = 16,
  pageHeightPx = 384,
): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  if (deltaMode === 1) return deltaY * pxPerLine;
  if (deltaMode === 2) return deltaY * pageHeightPx;
  return deltaY;
}

/**
 * Accumulates fractional pixel deltas across high-refresh trackpad frames so 120Hz 1px macOS
 * inertia events do not flood `±3` line scroll RPCs.
 */
export function accumulateWheelLines(
  accPx: number,
  deltaY: number,
  pxPerLine = 16,
): { lines: number; remainderPx: number } {
  const step = pxPerLine > 0 ? pxPerLine : 16;
  const total = (Number.isFinite(accPx) ? accPx : 0) + (Number.isFinite(deltaY) ? deltaY : 0);
  const rawLines = Math.trunc(total / step);
  const lines = rawLines === 0 ? 0 : rawLines;
  const remainderPx = total - lines * step;
  return {
    lines,
    remainderPx: remainderPx === 0 ? 0 : remainderPx,
  };
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

function arrowLetterForKey(keyId: string): "A" | "B" | "C" | "D" | null {
  switch (keyId) {
    case "up":
      return "A";
    case "down":
      return "B";
    case "right":
      return "C";
    case "left":
      return "D";
    default:
      return null;
  }
}

function csiModifierCode(ctrlLatch: StickyModifierLatch, altLatch: StickyModifierLatch): number {
  return 1 + (altLatch !== "off" ? 2 : 0) + (ctrlLatch !== "off" ? 4 : 0);
}

export function encodeAccessoryKey(
  keyId: string,
  applicationCursorKeysMode = false,
  ctrlLatch: StickyModifierLatch = "off",
  altLatch: StickyModifierLatch = "off",
): string {
  const arrowLetter = arrowLetterForKey(keyId);
  if (arrowLetter) {
    const mod = csiModifierCode(ctrlLatch, altLatch);
    if (mod > 1) {
      return `\x1b[1;${mod}${arrowLetter}`;
    }
    return applicationCursorKeysMode ? `\x1bO${arrowLetter}` : `\x1b[${arrowLetter}`;
  }

  let base = "";
  switch (keyId) {
    case "escape":
      base = "\x1b";
      break;
    case "tab":
      base = "\t";
      break;
    case "shift+tab":
      base = "\x1b[Z";
      break;
    case "enter":
      base = "\r";
      break;
    case "ctrl+c":
      base = "\x03";
      break;
    case "ctrl+d":
      base = "\x04";
      break;
    case "ctrl+z":
      base = "\x1a";
      break;
    case "ctrl+l":
      base = "\x0c";
      break;
    case "ctrl+r":
      base = "\x12";
      break;
    default:
      return "";
  }

  if (altLatch !== "off" && base.length > 0 && !base.startsWith("\x1b")) {
    return `\x1b${base}`;
  }
  return base;
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
  // Translate CSI / SS3 arrow sequences when sticky Ctrl or Alt latches are active.
  // eslint-disable-next-line no-control-regex
  const arrowMatch = text.match(/^\x1b[[O]([ABCD])$/);
  if (arrowMatch) {
    const mod = csiModifierCode(ctrlLatch, altLatch);
    if (mod > 1) {
      return `\x1b[1;${mod}${arrowMatch[1]}`;
    }
    return text;
  }

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

export function getOrCreateTerminalClientId(
  storage?: Pick<Storage, "getItem" | "setItem"> | null,
): string {
  const storageKey = "cmux_terminal_client_id";
  const store =
    storage !== undefined ? storage : typeof localStorage !== "undefined" ? localStorage : null;
  if (!store) return "pwa-default";
  try {
    const existing = store.getItem(storageKey);
    if (existing && existing.trim().length > 0) {
      return existing;
    }
    const created = `pwa-${Math.random().toString(36).slice(2, 10)}`;
    store.setItem(storageKey, created);
    return created;
  } catch {
    return "pwa-default";
  }
}
