import type { ProviderUsage } from "../../protocol/rpc";

export type UsageTone = "emerald" | "amber" | "rose";

export function clampUsedPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Orca consumption bands: green <60, amber 60–79, red >=80. */
export function usageTone(usedPercent: number): UsageTone {
  const used = clampUsedPercent(usedPercent);
  if (used >= 80) return "rose";
  if (used >= 60) return "amber";
  return "emerald";
}

export function formatResetCountdown(resetsAtMs: number | undefined, nowMs: number): string | null {
  if (resetsAtMs === undefined || !Number.isFinite(resetsAtMs)) return null;
  const remaining = resetsAtMs - nowMs;
  if (remaining <= 0) return "Resets now";
  const totalMins = Math.floor(remaining / 60_000);
  if (totalMins < 60) return `Resets in ${totalMins}m`;
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `Resets in ${days}d ${remHours}h` : `Resets in ${days}d`;
  }
  return mins > 0 ? `Resets in ${hours}h ${mins}m` : `Resets in ${hours}h`;
}

export function formatUpdatedAgo(updatedAtMs: number, nowMs: number): string {
  const diffMs = Math.max(0, nowMs - updatedAtMs);
  if (diffMs < 60_000) return "Updated just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `Updated ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `Updated ${hours}h ago`;
}

export function windowLabel(minutes: number, fallback?: string): string {
  if (minutes === 300) return "5h";
  if (minutes === 10_080) return "7d";
  if (minutes > 0 && minutes < 60) return `${minutes}m`;
  if (minutes >= 60 && minutes % 60 === 0 && minutes < 1440) return `${minutes / 60}h`;
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  return fallback || "Quota";
}

export interface HeadlineUsage {
  provider: string;
  shortName: string;
  usedPercent: number;
  tone: UsageTone;
  windowLabel: string;
}

const SHORT_NAMES: Record<string, string> = {
  antigravity: "AGY",
  claude: "Claude",
  codex: "Codex",
};

/** Picks the tightest (highest used %) window/bucket for compact status pills. */
export function headlineUsageForProvider(provider: ProviderUsage): HeadlineUsage | null {
  const candidates: { used: number; label: string }[] = [];
  if (provider.buckets && provider.buckets.length > 0) {
    for (const b of provider.buckets) {
      candidates.push({
        used: clampUsedPercent(b.used_percent),
        label: windowLabel(b.window_minutes, b.window_name || b.group),
      });
    }
  } else {
    if (provider.session) {
      candidates.push({
        used: clampUsedPercent(provider.session.used_percent),
        label: windowLabel(provider.session.window_minutes, "5h"),
      });
    }
    if (provider.weekly) {
      candidates.push({
        used: clampUsedPercent(provider.weekly.used_percent),
        label: windowLabel(provider.weekly.window_minutes, "7d"),
      });
    }
  }
  if (candidates.length === 0) return null;
  const tightest = candidates.reduce((best, cur) => (cur.used > best.used ? cur : best));
  return {
    provider: provider.provider,
    shortName: SHORT_NAMES[provider.provider] ?? provider.display_name,
    usedPercent: tightest.used,
    tone: usageTone(tightest.used),
    windowLabel: tightest.label,
  };
}

export function tightestHeadlineAcrossProviders(
  providers: readonly ProviderUsage[],
): HeadlineUsage | null {
  let best: HeadlineUsage | null = null;
  for (const p of providers) {
    const h = headlineUsageForProvider(p);
    if (h && (!best || h.usedPercent > best.usedPercent)) {
      best = h;
    }
  }
  return best;
}
