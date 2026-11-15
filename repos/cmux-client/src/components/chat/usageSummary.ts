/** Token usage shown next to the composer. Data: `usage` events the gateway parses from Claude transcripts. */
import type { AgentEvent, AgentTurn } from "../../protocol/event";

export type UsageEvent = Extract<AgentEvent, { kind: "usage" }>;

/** The most recent usage event across all turns, or null. */
export function latestUsage(turns: readonly AgentTurn[]): UsageEvent | null {
  for (let t = turns.length - 1; t >= 0; t -= 1) {
    const events = turns[t].events;
    for (let e = events.length - 1; e >= 0; e -= 1) {
      const ev = events[e];
      if (ev.kind === "usage") return ev;
    }
  }
  return null;
}

/** Size of the conversation as the model last saw it. */
export function contextTokens(u: UsageEvent): number {
  return u.input_tokens + (u.cache_read_tokens ?? 0) + (u.cache_creation_tokens ?? 0);
}

/** 524891 -> "524.9k", 1250000 -> "1.25M", 950 -> "950". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}k`;
  return String(n);
}
