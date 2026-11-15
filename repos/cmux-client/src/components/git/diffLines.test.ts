import { describe, expect, it } from "vite-plus/test";
import { classifyDiffLine, diffStat, statusLabel } from "./diffLines";

describe("diff helpers", () => {
  it("classifies unified diff lines", () => {
    expect(classifyDiffLine("@@ -1,2 +1,3 @@")).toBe("hunk");
    expect(classifyDiffLine("+++ b/a.txt")).toBe("meta");
    expect(classifyDiffLine("--- a/a.txt")).toBe("meta");
    expect(classifyDiffLine("diff --git a/a b/a")).toBe("meta");
    expect(classifyDiffLine("+two")).toBe("add");
    expect(classifyDiffLine("-one")).toBe("del");
    expect(classifyDiffLine(" same")).toBe("context");
    expect(classifyDiffLine("")).toBe("context");
  });

  it("counts changes without counting file headers", () => {
    const diff = [
      "diff --git a/a b/a",
      "--- a/a",
      "+++ b/a",
      "@@ -1 +1,2 @@",
      " one",
      "+two",
      "-old",
    ].join("\n");
    expect(diffStat(diff)).toEqual({ added: 1, removed: 1 });
  });

  it("labels porcelain letters", () => {
    expect(statusLabel("M")).toBe("Modified");
    expect(statusLabel("?")).toBe("Untracked");
    expect(statusLabel(" ")).toBe("");
  });
});
