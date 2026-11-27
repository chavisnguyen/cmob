import { describe, expect, it } from "vite-plus/test";
import type { SpendDay } from "../../protocol/rpc";
import {
  barPercent,
  dailyForPeriod,
  formatCost,
  formatTokens,
  localDateKey,
} from "./spendFormatting";

const day = (date: string): SpendDay => ({
  date,
  cost: 1,
  calls: 1,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
});

describe("spendFormatting", () => {
  it("formats cost with magnitude-aware precision", () => {
    expect(formatCost("$", 2221.47)).toBe("$2,221");
    expect(formatCost("$", 166.11)).toBe("$166");
    expect(formatCost("$", 12.345)).toBe("$12.35");
    expect(formatCost("$", 0.004)).toBe("<$0.01");
    expect(formatCost("$", 0)).toBe("$0.00");
    expect(formatCost("€", NaN)).toBe("€0");
  });

  it("formats token counts compactly", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(48_691_598)).toBe("49M");
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatTokens(9_978_734_960)).toBe("10.0B");
    expect(formatTokens(12_400_000_000)).toBe("12B");
  });

  it("selects chart days per period", () => {
    const daily = ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"].map(day);
    const now = new Date(2026, 10, 3, 12);
    expect(localDateKey(now)).toBe("2026-11-03");
    expect(dailyForPeriod(daily, "month", now).map((d) => d.date)).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
    ]);
    expect(dailyForPeriod(daily, "week", now)).toHaveLength(5);
  });

  it("computes bar widths", () => {
    expect(barPercent(50, 100)).toBe(50);
    expect(barPercent(0.1, 100)).toBe(2);
    expect(barPercent(0, 100)).toBe(0);
    expect(barPercent(5, 0)).toBe(0);
  });
});
