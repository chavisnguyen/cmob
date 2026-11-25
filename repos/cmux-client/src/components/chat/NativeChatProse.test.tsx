import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { normalizeChatMarkdownMath } from "./chatMarkdownMath";
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

  it("converts inline LaTeX math symbols outside code spans and renders file:// links as code chips", () => {
    const raw =
      "Giữ làm repo độc lập $\\rightarrow$ `Formula/` + CI. Không động vào `$\\rightarrow$` hay `$PATH` hay $10. Xem [md2pdf/md2pdf.sh](file:///Users/chavis/Documents/personal/md2pdf/md2pdf.sh#L1-L34).";
    expect(normalizeChatMarkdownMath(raw)).toContain("repo độc lập → `Formula/`");
    expect(normalizeChatMarkdownMath(raw)).toContain("`$\\rightarrow$`");
    expect(normalizeChatMarkdownMath(raw)).toContain("`$PATH`");
    expect(normalizeChatMarkdownMath(raw)).toContain("$10");

    const out = html(raw);
    expect(out).toContain("repo độc lập →");
    expect(out).toContain("$\\rightarrow$");
    expect(out).toContain('title="/Users/chavis/Documents/personal/md2pdf/md2pdf.sh#L1-L34"');
    expect(out).toContain("md2pdf/md2pdf.sh");
  });
});
