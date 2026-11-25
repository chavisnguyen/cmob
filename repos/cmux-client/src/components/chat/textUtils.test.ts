import { describe, expect, it } from "vite-plus/test";
import { plainSnippet, shortPath } from "./textUtils";

describe("plainSnippet / shortPath", () => {
  it("removes wrapper tags and markdown markers", () => {
    expect(plainSnippet('<agent-message from="ada45">\n[Subagent] ok</agent-message>')).toBe(
      "[Subagent] ok",
    );
    expect(plainSnippet("R1-a đã sửa `repos/x.rs` **xong**")).toBe("R1-a đã sửa repos/x.rs xong");
    expect(plainSnippet("Mình đề xuất: 1. **Thử lại**")).toBe("Mình đề xuất: 1. Thử lại");
    expect(plainSnippet("[Image #1]")).toBe("🖼 Image 1");
    expect(plainSnippet("[Image: source: /tmp/a.png] check")).toBe("🖼 Image check");
  });
  it("keeps the tail of a path", () => {
    expect(shortPath("/Users/dev/work/app")).toBe("…/work/app");
    expect(shortPath("/Users/dev")).toBe("/Users/dev");
  });
});
