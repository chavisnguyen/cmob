/* eslint-disable no-control-regex */
/**
 * Lightweight, zero-dependency ANSI SGR Color & Style Parser
 * Converts raw terminal escape sequences into structured React elements.
 * Sources:
 * - ECMA-48 / ISO 6429 Control Functions for Coded Character Sets
 * - ref/orca/mobile/scripts/repro-terminal-colors.ts
 */

import React from "react";

// Standard 16 ANSI Color Palette (Tailwind / Modern Terminal Palette)
const ANSI_FG_PALETTE: Record<number, string> = {
  30: "#4b5563", // Black / Dark Gray
  31: "#ef4444", // Red
  32: "#22c55e", // Green
  33: "#eab308", // Yellow
  34: "#3b82f6", // Blue
  35: "#a855f7", // Magenta / Purple
  36: "#06b6d4", // Cyan
  37: "#e5e7eb", // White / Light Gray

  // Bright / High-Intensity Colors (90-97)
  90: "#6b7280", // Bright Black / Gray
  91: "#f87171", // Bright Red
  92: "#4ade80", // Bright Green
  93: "#facc15", // Bright Yellow
  94: "#60a5fa", // Bright Blue
  95: "#c084fc", // Bright Magenta
  96: "#22d3ee", // Bright Cyan
  97: "#ffffff", // Bright White
};

const ANSI_BG_PALETTE: Record<number, string> = {
  40: "#111827", // Black
  41: "#7f1d1d", // Dark Red
  42: "#14532d", // Dark Green
  43: "#713f12", // Dark Yellow
  44: "#1e3a8a", // Dark Blue
  45: "#581c87", // Dark Magenta
  46: "#164e63", // Dark Cyan
  47: "#374151", // Gray

  100: "#374151",
  101: "#991b1b",
  102: "#166534",
  103: "#854d0e",
  104: "#1e40af",
  105: "#6b21a8",
  106: "#155e75",
  107: "#4b5563",
};

interface AnsiStyleState {
  color?: string;
  backgroundColor?: string;
  fontWeight?: "bold" | "normal";
  fontStyle?: "italic" | "normal";
  textDecoration?: "underline" | "none";
  opacity?: number;
}

function parse256Color(n: number): string {
  if (n < 8) return ANSI_FG_PALETTE[30 + n] ?? "#e5e7eb";
  if (n < 16) return ANSI_FG_PALETTE[90 + (n - 8)] ?? "#ffffff";
  if (n >= 232) {
    // 24 Grayscale levels
    const gray = Math.round(8 + (n - 232) * 10);
    return `rgb(${gray}, ${gray}, ${gray})`;
  }
  // 6x6x6 color cube (indices 16 to 231)
  const idx = n - 16;
  const b = idx % 6;
  const g = Math.floor(idx / 6) % 6;
  const r = Math.floor(idx / 36);
  const toRgb = (v: number) => (v === 0 ? 0 : 55 + v * 40);
  return `rgb(${toRgb(r)}, ${toRgb(g)}, ${toRgb(b)})`;
}

/**
 * Strips non-SGR ANSI escape sequences (cursor movement, clear screen, OSC, title set).
 */
export function stripNonSgrAnsi(input: string): string {
  return (
    input
      // OSC sequences (e.g., \x1b]0;title\x07 or \x1b]...\x1b\\)
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // Cursor & mode control sequences (e.g., \x1b[?25h, \x1b[2J, \x1b[K, \x1b[2;1H)
      .replace(/\x1b\[[0-9;?]*[A-HJKSTfhilnsu]/g, "")
  );
}

/**
 * Parses raw terminal text with ANSI escape codes into an array of styled React spans.
 */
export function parseAnsiToReact(input: string): React.ReactNode[] {
  if (!input) return [];

  // Strip non-color control sequences first
  const cleanInput = stripNonSgrAnsi(input);

  // Regex matching ANSI SGR sequences: \x1b[...m
  const sgrRegex = /\x1b\[([0-9;]*)m/g;
  const nodes: React.ReactNode[] = [];

  let lastIndex = 0;
  let match: RegExpExecArray | null = null;
  let keyIndex = 0;

  // Active terminal style state
  let currentStyle: AnsiStyleState = {};

  const pushSpan = (text: string) => {
    if (!text) return;
    const hasStyle =
      currentStyle.color ||
      currentStyle.backgroundColor ||
      currentStyle.fontWeight ||
      currentStyle.textDecoration ||
      currentStyle.fontStyle ||
      currentStyle.opacity !== undefined;

    if (hasStyle) {
      const style: React.CSSProperties = {};
      if (currentStyle.color) style.color = currentStyle.color;
      if (currentStyle.backgroundColor) style.backgroundColor = currentStyle.backgroundColor;
      if (currentStyle.fontWeight) style.fontWeight = currentStyle.fontWeight;
      if (currentStyle.fontStyle) style.fontStyle = currentStyle.fontStyle;
      if (currentStyle.textDecoration) style.textDecoration = currentStyle.textDecoration;
      if (currentStyle.opacity !== undefined) style.opacity = currentStyle.opacity;

      nodes.push(React.createElement("span", { key: `ansi-${keyIndex++}`, style }, text));
    } else {
      nodes.push(text);
    }
  };

  while ((match = sgrRegex.exec(cleanInput)) !== null) {
    const textChunk = cleanInput.slice(lastIndex, match.index);
    pushSpan(textChunk);
    lastIndex = sgrRegex.lastIndex;

    // Parse SGR codes
    const codeString = match[1] ?? "";
    const codes = codeString.length > 0 ? codeString.split(";").map((c) => parseInt(c, 10)) : [0];

    let i = 0;
    while (i < codes.length) {
      const code = codes[i] ?? 0;

      if (code === 0) {
        // Reset all styles
        currentStyle = {};
      } else if (code === 1) {
        currentStyle.fontWeight = "bold";
      } else if (code === 2) {
        currentStyle.opacity = 0.65; // Dim
      } else if (code === 3) {
        currentStyle.fontStyle = "italic";
      } else if (code === 4) {
        currentStyle.textDecoration = "underline";
      } else if (code === 22) {
        currentStyle.fontWeight = "normal";
        delete currentStyle.opacity;
      } else if (code === 23) {
        currentStyle.fontStyle = "normal";
      } else if (code === 24) {
        currentStyle.textDecoration = "none";
      } else if (code >= 30 && code <= 37) {
        // Standard Foreground
        currentStyle.color = ANSI_FG_PALETTE[code];
      } else if (code === 38) {
        // Extended 256 or Truecolor Foreground
        if (codes[i + 1] === 5 && codes[i + 2] !== undefined) {
          currentStyle.color = parse256Color(codes[i + 2]);
          i += 2;
        } else if (
          codes[i + 1] === 2 &&
          codes[i + 2] !== undefined &&
          codes[i + 3] !== undefined &&
          codes[i + 4] !== undefined
        ) {
          currentStyle.color = `rgb(${codes[i + 2]}, ${codes[i + 3]}, ${codes[i + 4]})`;
          i += 4;
        }
      } else if (code === 39) {
        // Default Foreground
        delete currentStyle.color;
      } else if (code >= 40 && code <= 47) {
        // Standard Background
        currentStyle.backgroundColor = ANSI_BG_PALETTE[code];
      } else if (code === 48) {
        // Extended 256 or Truecolor Background
        if (codes[i + 1] === 5 && codes[i + 2] !== undefined) {
          currentStyle.backgroundColor = parse256Color(codes[i + 2]);
          i += 2;
        } else if (
          codes[i + 1] === 2 &&
          codes[i + 2] !== undefined &&
          codes[i + 3] !== undefined &&
          codes[i + 4] !== undefined
        ) {
          currentStyle.backgroundColor = `rgb(${codes[i + 2]}, ${codes[i + 3]}, ${codes[i + 4]})`;
          i += 4;
        }
      } else if (code === 49) {
        // Default Background
        delete currentStyle.backgroundColor;
      } else if (code >= 90 && code <= 97) {
        // Bright Foreground
        currentStyle.color = ANSI_FG_PALETTE[code];
      } else if (code >= 100 && code <= 107) {
        // Bright Background
        currentStyle.backgroundColor = ANSI_BG_PALETTE[code];
      }

      i++;
    }
  }

  // Push remaining text
  if (lastIndex < cleanInput.length) {
    pushSpan(cleanInput.slice(lastIndex));
  }

  return nodes;
}
