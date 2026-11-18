import { describe, expect, it } from "vite-plus/test";
import { canScanQr, relativeTime } from "./deviceUtils";

describe("deviceUtils", () => {
  describe("relativeTime", () => {
    const fixedNowMs = 1700000000000; // fixed timestamp in ms (~1700000000s)
    const fixedNowSec = 1700000000;

    it("formats timestamps within 90 seconds as 'just now'", () => {
      expect(relativeTime(fixedNowSec, fixedNowMs)).toBe("just now");
      expect(relativeTime(fixedNowSec - 30, fixedNowMs)).toBe("just now");
      expect(relativeTime(fixedNowSec - 89, fixedNowMs)).toBe("just now");
    });

    it("handles future timestamps gracefully by clamping to 0 diff", () => {
      expect(relativeTime(fixedNowSec + 100, fixedNowMs)).toBe("just now");
    });

    it("formats minutes ago", () => {
      expect(relativeTime(fixedNowSec - 90, fixedNowMs)).toBe("1 min ago");
      expect(relativeTime(fixedNowSec - 120, fixedNowMs)).toBe("2 min ago");
      expect(relativeTime(fixedNowSec - 3599, fixedNowMs)).toBe("59 min ago");
    });

    it("formats hours ago", () => {
      expect(relativeTime(fixedNowSec - 3600, fixedNowMs)).toBe("1 h ago");
      expect(relativeTime(fixedNowSec - 7200, fixedNowMs)).toBe("2 h ago");
      expect(relativeTime(fixedNowSec - 86399, fixedNowMs)).toBe("23 h ago");
    });

    it("formats days ago", () => {
      expect(relativeTime(fixedNowSec - 86400, fixedNowMs)).toBe("1 d ago");
      expect(relativeTime(fixedNowSec - 172800, fixedNowMs)).toBe("2 d ago");
      expect(relativeTime(fixedNowSec - 864000, fixedNowMs)).toBe("10 d ago");
    });
  });

  describe("canScanQr", () => {
    it("returns a boolean based on mediaDevices availability", () => {
      const result = canScanQr();
      expect(typeof result).toBe("boolean");
    });
  });
});
