import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { NativeChatProse } from "./NativeChatProse";

const html = (md: string) => renderToStaticMarkup(<NativeChatProse content={md} />);

describe("NativeChatProse", () => {
  it("renders numbered lists, nested bullets, bold and inline code", () => {
    const out = html("1. **Thử lại**\n2. Commit `x`\n\n- a\n  - b");
    expect(out).toContain("<ol");
    expect(out).toContain("<strong");
    expect(out).toMatch(/<code[^>]*>x<\/code>/);
    expect((out.match(/<ul/g) ?? []).length).toBe(2);
  });

  it("renders GFM tables inside a scroll container", () => {
    const out = html("| A | B |\n|---|---|\n| 1 | 2 |");
    expect(out).toContain("overflow-x-auto");
    expect(out).toContain("<th");
    expect(out).toContain("<td");
  });

  it("turns fenced code into the copyable block with its language", () => {
    const out = html("```rust\nfn main() {}\n```");
    expect(out).toContain("rust");
    expect(out).toContain("Copy");
    expect(out).toContain("fn main() {}");
  });

  it("never emits raw HTML or script from the text", () => {
    const out = html("<script>alert(1)</script> <img src=x onerror=alert(1)> hello");
    // Shown as escaped text, never as elements.
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("hello");
  });

  it("drops non-http links and shows remote images as links, not <img>", () => {
    const out = html("[x](javascript:alert(1)) ![pic](https://e.com/a.png)");
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("<img");
    expect(out).toContain('href="https://e.com/a.png"');
  });
});
