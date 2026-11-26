import type { AgentTurn } from "../../protocol/event";

/**
 * Strips raw internal agent XML envelopes like `<USER_REQUEST>` and `<ADDITIONAL_METADATA>`
 * and normalizes CLI image placeholders (`[Image #3]`, `[Image: source: ...]`) for clean display.
 */
export function cleanUserPrompt(text: string): string {
  let s = text.trim();
  const reqMatch = s.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  if (reqMatch) {
    s = reqMatch[1].trim();
  } else {
    const promptMatch = s.match(/<user_prompt>([\s\S]*?)<\/user_prompt>/i);
    if (promptMatch) {
      s = promptMatch[1].trim();
    }
  }
  s = s.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "").trim();
  return s
    .replace(/\[Image(?: #(\d+))?(?::[^\]]*)?\]/g, (_, n) => (n ? `🖼 Image ${n}` : "🖼 Image"))
    .trim();
}

/**
 * Produces a canonical comparison key for matching optimistic `pendingSends` against echoed
 * transcript user turns across `<USER_REQUEST>` wrappers and `[Image #N]` attachments.
 */
export function normalizeComparablePrompt(rawText: string, hasImages = false): string {
  const cleaned = cleanUserPrompt(rawText);
  const withoutImageBadges = cleaned
    .replace(/🖼\s*Image(?:\s+\d+)?/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!withoutImageBadges && (hasImages || /🖼\s*Image/.test(cleaned))) {
    return "[image-only]";
  }
  return withoutImageBadges;
}

export function extractNormalizedUserTurnKeys(turns: readonly AgentTurn[]): string[] {
  const keys: string[] = [];
  for (const turn of turns) {
    if (turn.role !== "user") continue;
    const raw = turn.events.map((e) => (e.kind === "user" ? e.text : "")).join(" ");
    keys.push(normalizeComparablePrompt(raw));
  }
  return keys;
}

export function countMatchingUserTurns(
  turns: readonly AgentTurn[],
  text: string,
  hasImages = false,
): number {
  const wanted = normalizeComparablePrompt(text, hasImages);
  return extractNormalizedUserTurnKeys(turns).filter((k) => k === wanted).length;
}
