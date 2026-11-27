import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { cachedChatImage } from "./chatImageCache";
import { ChatImageThumb } from "./ChatImages";

describe("ChatImageThumb", () => {
  it("renders a tappable preview for an available src", () => {
    const out = renderToStaticMarkup(<ChatImageThumb src="blob:abc" />);
    expect(out).toContain('src="blob:abc"');
    expect(out).toContain("View attached image");
    expect(out).not.toContain('disabled=""');
  });

  it("shows a disabled placeholder until a transcript image is fetched", () => {
    const out = renderToStaticMarkup(<ChatImageThumb imageId="u-1#0" />);
    expect(out).not.toContain("<img");
    expect(out).toContain('disabled=""');
  });
});

describe("cachedChatImage", () => {
  it("fetches once per id and retries after a failure", async () => {
    let calls = 0;
    const load = () => {
      calls += 1;
      return Promise.resolve("data:image/png;base64,QQ==");
    };
    await cachedChatImage("cache-a#0", load);
    await cachedChatImage("cache-a#0", load);
    expect(calls).toBe(1);

    let attempts = 0;
    const flaky = () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("boom")) : Promise.resolve("ok");
    };
    await expect(cachedChatImage("cache-b#0", flaky)).rejects.toThrow("boom");
    await expect(cachedChatImage("cache-b#0", flaky)).resolves.toBe("ok");
  });

  it("evicts the oldest entries past the cap", async () => {
    let calls = 0;
    const load = () => {
      calls += 1;
      return Promise.resolve("x");
    };
    for (let i = 0; i < 30; i += 1) await cachedChatImage(`evict-${i}#0`, load);
    const before = calls;
    await cachedChatImage("evict-0#0", load);
    expect(calls).toBe(before + 1);
  });
});
