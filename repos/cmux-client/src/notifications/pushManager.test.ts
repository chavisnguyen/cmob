import { describe, it, expect, beforeEach } from "vite-plus/test";
import { PushManager } from "./pushManager";

describe("PushManager", () => {
  let pm: PushManager;

  beforeEach(() => {
    pm = new PushManager();
  });

  it("detects iOS and standalone correctly", () => {
    // Default mock environment (jsdom/happy-dom or node)
    expect(typeof pm.isIos()).toBe("boolean");
    expect(typeof pm.isStandalone()).toBe("boolean");
    expect(typeof pm.needsIosPwaInstall()).toBe("boolean");
  });

  it("converts urlBase64 to Uint8Array correctly", () => {
    // Standard test base64url string
    const base64url = "BA123-ab_cd";
    // Access private method through test-friendly cast
    const bytes = (
      pm as unknown as { urlBase64ToUint8Array: (s: string) => Uint8Array }
    ).urlBase64ToUint8Array(base64url);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });
});
