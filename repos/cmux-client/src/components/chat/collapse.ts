/** Long chat messages are folded on a phone; these helpers decide when and how much to show. */

import { plainSnippet } from "./textUtils";

export const COLLAPSE_MAX_LINES = 8;
export const COLLAPSE_MAX_CHARS = 700;
const PREVIEW_LINES = 5;
const PREVIEW_CHARS = 420;
const INJECTED_PREVIEW_CHARS = 140;

/** Text the harness injected into the conversation (reminders, command envelopes), not typed by a person. */
const INJECTED_PREFIX =
  /^\s*(<(system-reminder|local-command-[a-z]+|command-(name|message|args)|task-notification|user-prompt-submit-hook)\b|This session is being continued from a previous conversation)/i;

export function isInjectedMessage(text: string): boolean {
  return INJECTED_PREFIX.test(text);
}

export interface CollapsePlan {
  /** True when the text is long enough to fold. */
  collapsible: boolean;
  /** Visible portion while folded (the whole text when not collapsible). */
  preview: string;
  injected: boolean;
  hiddenLines: number;
}

function clip(text: string, lines: number, chars: number): string {
  const head = text.split("\n").slice(0, lines).join("\n");
  return head.length > chars ? `${head.slice(0, chars).trimEnd()}` : head;
}

export function planCollapse(raw: string): CollapsePlan {
  const text = raw.trim();
  const injected = isInjectedMessage(text);
  const lineCount = text === "" ? 0 : text.split("\n").length;
  const collapsible =
    injected || lineCount > COLLAPSE_MAX_LINES || text.length > COLLAPSE_MAX_CHARS;
  if (!collapsible) return { collapsible: false, preview: text, injected, hiddenLines: 0 };
  const preview = injected
    ? plainSnippet(text).slice(0, INJECTED_PREVIEW_CHARS)
    : clip(text, PREVIEW_LINES, PREVIEW_CHARS);
  const shown = injected ? 0 : preview === "" ? 0 : preview.split("\n").length;
  return { collapsible, preview, injected, hiddenLines: Math.max(0, lineCount - shown) };
}
