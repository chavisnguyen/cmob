import { describe, expect, it } from "vite-plus/test";
import { parseMarkdownPath, resolveSiblingPath } from "./mdPath";

describe("parseMarkdownPath", () => {
  it("accepts relative, absolute and file:// markdown paths", () => {
    expect(parseMarkdownPath("next_steps_20261126.md")).toBe("next_steps_20261126.md");
    expect(parseMarkdownPath("docs/learn/11-dispute-flow.md")).toBe(
      "docs/learn/11-dispute-flow.md",
    );
    expect(parseMarkdownPath("/Users/a/proj/PLAN.MD")).toBe("/Users/a/proj/PLAN.MD");
    expect(parseMarkdownPath("file:///Users/a/my%20plan.md")).toBe("/Users/a/my plan.md");
    expect(parseMarkdownPath("./README.mdx")).toBe("./README.mdx");
  });

  it("strips line numbers and fragments", () => {
    expect(parseMarkdownPath("AGENTS.md:42")).toBe("AGENTS.md");
    expect(parseMarkdownPath("AGENTS.md:42:7")).toBe("AGENTS.md");
    expect(parseMarkdownPath("docs/a.md#section")).toBe("docs/a.md");
  });

  it("rejects non-markdown, urls, globs and prose", () => {
    expect(parseMarkdownPath("https://example.com/readme.md")).toBeNull();
    expect(parseMarkdownPath("docs/*.md")).toBeNull();
    expect(parseMarkdownPath("see plan.md now")).toBeNull();
    expect(parseMarkdownPath("main.rs")).toBeNull();
    expect(parseMarkdownPath("#intro")).toBeNull();
    expect(parseMarkdownPath("")).toBeNull();
    expect(parseMarkdownPath("`x.md`")).toBeNull();
  });
});

describe("resolveSiblingPath", () => {
  it("resolves relative to the current file's directory", () => {
    expect(resolveSiblingPath("docs/a.md", "b.md")).toBe("docs/b.md");
    expect(resolveSiblingPath("docs/a.md", "../README.md")).toBe("README.md");
    expect(resolveSiblingPath("a.md", "./sub/b.md")).toBe("sub/b.md");
    expect(resolveSiblingPath("docs/a.md", "/abs/x.md")).toBe("/abs/x.md");
    expect(resolveSiblingPath("/w/docs/a.md", "../b.md")).toBe("/w/b.md");
    expect(resolveSiblingPath("a.md", "../out.md")).toBe("../out.md");
  });
});
