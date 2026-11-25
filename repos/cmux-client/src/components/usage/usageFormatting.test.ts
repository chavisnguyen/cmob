import { describe, expect, it } from "vite-plus/test";
import type { ProviderUsage } from "../../protocol/rpc";
import {
  formatResetCountdown,
  formatUpdatedAgo,
  headlineUsageForProvider,
  tightestHeadlineAcrossProviders,
  usageTone,
  windowLabel,
} from "./usageFormatting";

describe("usageFormatting", () => {
  it("maps consumption thresholds to emerald/amber/rose", () => {
    expect(usageTone(0)).toBe("emerald");
    expect(usageTone(59)).toBe("emerald");
    expect(usageTone(60)).toBe("amber");
    expect(usageTone(79)).toBe("amber");
    expect(usageTone(80)).toBe("rose");
    expect(usageTone(120)).toBe("rose");
  });

  it("formats reset countdowns across minutes, hours, and days", () => {
    const now = 1_700_000_000_000;
    expect(formatResetCountdown(undefined, now)).toBeNull();
    expect(formatResetCountdown(now - 1000, now)).toBe("Resets now");
    expect(formatResetCountdown(now + 47 * 60_000, now)).toBe("Resets in 47m");
    expect(formatResetCountdown(now + (3 * 60 + 54) * 60_000, now)).toBe("Resets in 3h 54m");
    expect(formatResetCountdown(now + (6 * 24 + 7) * 3600_000, now)).toBe("Resets in 6d 7h");
    expect(formatUpdatedAgo(now - 30_000, now)).toBe("Updated just now");
    expect(formatUpdatedAgo(now - 5 * 60_000, now)).toBe("Updated 5m ago");
    expect(windowLabel(300)).toBe("5h");
    expect(windowLabel(10_080)).toBe("7d");
  });

  it("picks tightest window or bucket for status pill", () => {
    const agy: ProviderUsage = {
      provider: "antigravity",
      display_name: "Antigravity",
      status: "ok",
      updated_at: 1000,
      buckets: [
        {
          id: "g-5h",
          name: "Gemini · 5h",
          group: "Gemini",
          used_percent: 21,
          window_minutes: 300,
        },
        {
          id: "g-w",
          name: "Gemini · Weekly",
          group: "Gemini",
          used_percent: 6,
          window_minutes: 10_080,
        },
      ],
    };
    const codex: ProviderUsage = {
      provider: "codex",
      display_name: "Codex",
      status: "ok",
      updated_at: 1000,
      session: { used_percent: 14, window_minutes: 300 },
      weekly: { used_percent: 82, window_minutes: 10_080 },
    };

    expect(headlineUsageForProvider(agy)).toEqual({
      provider: "antigravity",
      shortName: "AGY",
      usedPercent: 21,
      tone: "emerald",
      windowLabel: "5h",
    });
    expect(tightestHeadlineAcrossProviders([agy, codex])).toEqual({
      provider: "codex",
      shortName: "Codex",
      usedPercent: 82,
      tone: "rose",
      windowLabel: "7d",
    });
  });
});
