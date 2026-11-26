import type { ITheme } from "@xterm/xterm";
import type {
  RenderGridData,
  RenderGridSpan,
  RenderGridStyle,
  RenderGridTheme,
} from "../../protocol/rpc";

export interface TerminalGridModes {
  altScreen: boolean;
  applicationCursorKeysMode: boolean;
  bracketedPasteMode: boolean;
  mouseTrackingMode: "none" | "x10" | "normal" | "button" | "any";
  sgrMouseMode: boolean;
  sgrMousePixelsMode: boolean;
}

export interface ConvertedRenderGrid {
  columns: number;
  rows: number;
  ansiPayload: string;
  modes: TerminalGridModes;
  theme: ITheme;
}

function parseHexRgb(hex: string | undefined): [number, number, number] | null {
  if (!hex) return null;
  const normalized = hex.startsWith("#") ? hex.slice(1) : hex;
  if (normalized.length !== 6) return null;
  const red = parseInt(normalized.slice(0, 2), 16);
  const green = parseInt(normalized.slice(2, 4), 16);
  const blue = parseInt(normalized.slice(4, 6), 16);
  if (Number.isNaN(red) || Number.isNaN(green) || Number.isNaN(blue)) return null;
  return [red, green, blue];
}

function styleToSgrSequence(style: RenderGridStyle | undefined): string {
  if (!style) return "\x1b[0m";
  const params: string[] = ["0"];
  if (style.bold) params.push("1");
  if (style.faint) params.push("2");
  if (style.italic) params.push("3");
  if (style.underline) params.push("4");
  if (style.blink) params.push("5");
  if (style.inverse) params.push("7");
  if (style.invisible) params.push("8");
  if (style.strikethrough) params.push("9");

  if (style.foreground_source !== "default") {
    const rgb = parseHexRgb(style.foreground);
    if (rgb) {
      params.push("38", "2", String(rgb[0]), String(rgb[1]), String(rgb[2]));
    }
  }
  if (style.background_source !== "default") {
    const rgb = parseHexRgb(style.background);
    if (rgb) {
      params.push("48", "2", String(rgb[0]), String(rgb[1]), String(rgb[2]));
    }
  }
  return `\x1b[${params.join(";")}m`;
}

export function extractGridModes(grid: RenderGridData): TerminalGridModes {
  const activePrivateModes = new Set<number>();
  for (const mode of grid.modes ?? []) {
    if (!mode.ansi && mode.on) {
      activePrivateModes.add(mode.code);
    }
  }

  let mouseTrackingMode: TerminalGridModes["mouseTrackingMode"] = "none";
  if (activePrivateModes.has(1003)) {
    mouseTrackingMode = "any";
  } else if (activePrivateModes.has(1002)) {
    mouseTrackingMode = "button";
  } else if (activePrivateModes.has(1000)) {
    mouseTrackingMode = "normal";
  } else if (activePrivateModes.has(9)) {
    mouseTrackingMode = "x10";
  }

  return {
    altScreen: grid.active_screen === "alternate",
    applicationCursorKeysMode: activePrivateModes.has(1),
    bracketedPasteMode: activePrivateModes.has(2004),
    mouseTrackingMode,
    sgrMouseMode: activePrivateModes.has(1006),
    sgrMousePixelsMode: activePrivateModes.has(1016),
  };
}

export function extractXtermTheme(
  rawTheme: RenderGridTheme | undefined,
  fallbackBg?: string,
  fallbackFg?: string,
): ITheme {
  const palette = rawTheme?.palette ?? [];
  return {
    background: rawTheme?.background || fallbackBg || "#14151c",
    foreground: rawTheme?.foreground || fallbackFg || "#f3f4f6",
    cursor: rawTheme?.cursor || "#fcfcfa",
    cursorAccent: rawTheme?.cursorText || "#14151c",
    selectionBackground: rawTheme?.selectionBackground || "#3e4451",
    selectionForeground: rawTheme?.selectionForeground,
    black: palette[0],
    red: palette[1],
    green: palette[2],
    yellow: palette[3],
    blue: palette[4],
    magenta: palette[5],
    cyan: palette[6],
    white: palette[7],
    brightBlack: palette[8],
    brightRed: palette[9],
    brightGreen: palette[10],
    brightYellow: palette[11],
    brightBlue: palette[12],
    brightMagenta: palette[13],
    brightCyan: palette[14],
    brightWhite: palette[15],
  };
}

function buildSpanLines(
  spans: RenderGridSpan[] | undefined,
  rowCount: number,
  columns: number,
  sgrByStyleId: Map<number, string>,
): string[] {
  const rows: RenderGridSpan[][] = Array.from({ length: rowCount }, () => []);
  for (const span of spans ?? []) {
    if (span.row >= 0 && span.row < rowCount) {
      rows[span.row].push(span);
    }
  }

  const lines: string[] = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const rowSpans = rows[rowIndex];
    if (rowSpans.length === 0) {
      lines.push("");
      continue;
    }
    rowSpans.sort((left, right) => left.column - right.column);
    let line = "";
    let currentCol = 0;
    let lastStyleId = 0;

    for (const span of rowSpans) {
      if (span.column >= columns) continue;
      if (span.column > currentCol) {
        if (lastStyleId !== 0) {
          line += "\x1b[0m";
          lastStyleId = 0;
        }
        line += " ".repeat(span.column - currentCol);
        currentCol = span.column;
      }
      if (span.style_id !== lastStyleId) {
        line += sgrByStyleId.get(span.style_id) ?? "\x1b[0m";
        lastStyleId = span.style_id;
      }
      line += span.text;
      const width = span.cell_width && span.cell_width > 0 ? span.cell_width : span.text.length;
      currentCol += width;
    }
    if (lastStyleId !== 0) {
      line += "\x1b[0m";
    }
    lines.push(line);
  }
  return lines;
}

export function convertRenderGridToAnsi(grid: RenderGridData): ConvertedRenderGrid {
  const columns = Math.max(1, grid.columns || 80);
  const rows = Math.max(1, grid.rows || 24);
  const modes = extractGridModes(grid);
  const theme = extractXtermTheme(
    grid.terminal_theme,
    grid.terminal_background,
    grid.terminal_foreground,
  );

  const sgrByStyleId = new Map<number, string>();
  sgrByStyleId.set(0, "\x1b[0m");
  for (const style of grid.styles ?? []) {
    sgrByStyleId.set(style.id, styleToSgrSequence(style));
  }

  const chunks: string[] = [];
  chunks.push("\x1b[?2026h\x1b[?25l\x1b[0m");

  if (modes.altScreen) {
    chunks.push("\x1b[?1049h\x1b[H\x1b[2J");
    const viewportLines = buildSpanLines(grid.row_spans, rows, columns, sgrByStyleId);
    for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
      chunks.push(`\x1b[${rowIndex + 1};1H${viewportLines[rowIndex] ?? ""}`);
    }
  } else {
    chunks.push("\x1b[?1049l\x1b[H\x1b[2J\x1b[3J");
    const scrollbackCount = Math.max(0, grid.scrollback_rows ?? 0);
    if (scrollbackCount > 0) {
      const scrollbackLines = buildSpanLines(
        grid.scrollback_spans,
        scrollbackCount,
        columns,
        sgrByStyleId,
      );
      for (const line of scrollbackLines) {
        chunks.push(`${line}\r\n`);
      }
    }
    const viewportLines = buildSpanLines(grid.row_spans, rows, columns, sgrByStyleId);
    for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
      const suffix = rowIndex < rows - 1 ? "\r\n" : "";
      chunks.push(`${viewportLines[rowIndex] ?? ""}${suffix}`);
    }
  }

  const cursor = grid.cursor;
  if (cursor) {
    const targetRow = Math.max(0, Math.min(rows - 1, cursor.row)) + 1;
    const targetCol = Math.max(0, Math.min(columns - 1, cursor.column)) + 1;
    const styleCode =
      cursor.style === "underline"
        ? cursor.blinking
          ? 3
          : 4
        : cursor.style === "bar"
          ? cursor.blinking
            ? 5
            : 6
          : cursor.blinking
            ? 1
            : 2;
    chunks.push(`\x1b[${styleCode} q\x1b[${targetRow};${targetCol}H`);
    chunks.push(cursor.visible === false ? "\x1b[?25l" : "\x1b[?25h");
  } else {
    chunks.push("\x1b[?25h");
  }

  chunks.push(modes.applicationCursorKeysMode ? "\x1b[?1h" : "\x1b[?1l");
  chunks.push(modes.bracketedPasteMode ? "\x1b[?2004h" : "\x1b[?2004l");
  chunks.push("\x1b[?2026l");

  return {
    columns,
    rows,
    ansiPayload: chunks.join(""),
    modes,
    theme,
  };
}
