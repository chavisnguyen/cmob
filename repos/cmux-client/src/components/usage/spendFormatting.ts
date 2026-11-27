import type { SpendDay, SpendPeriod } from "../../protocol/rpc";

export const SPEND_PERIODS: { id: SpendPeriod; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "30days", label: "30 days" },
];

export function formatCost(symbol: string, cost: number): string {
  if (!Number.isFinite(cost)) return `${symbol}0`;
  const abs = Math.abs(cost);
  if (abs >= 1000) return `${symbol}${Math.round(cost).toLocaleString("en-US")}`;
  if (abs >= 100) return `${symbol}${cost.toFixed(0)}`;
  if (abs > 0 && abs < 0.01) return `<${symbol}0.01`;
  return `${symbol}${cost.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}

/** Local `YYYY-MM-DD` for `now`. */
export function localDateKey(now: Date): string {
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${m}-${d}`;
}

/** Days shown in the bar chart for a period (daily history is independent of the period). */
export function dailyForPeriod(
  daily: readonly SpendDay[],
  period: SpendPeriod,
  now: Date,
): SpendDay[] {
  switch (period) {
    case "today":
    case "week":
      return daily.slice(-7);
    case "30days":
      return daily.slice(-30);
    case "month": {
      const prefix = localDateKey(now).slice(0, 7);
      return daily.filter((d) => d.date.startsWith(prefix));
    }
  }
}

/** Share of `max`, as a 0–100 integer width (min 2 so non-zero rows stay visible). */
export function barPercent(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.max(2, Math.min(100, Math.round((value / max) * 100)));
}
