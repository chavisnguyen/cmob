import { describe, expect, it } from "vite-plus/test";
import { isInjectedMessage, planCollapse } from "./collapse";

describe("planCollapse", () => {
  it("leaves short messages alone", () => {
    const p = planCollapse("fix the bug\nplease");
    expect(p).toMatchObject({
      collapsible: false,
      preview: "fix the bug\nplease",
      injected: false,
    });
  });

  it("folds many lines and reports hidden count", () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const p = planCollapse(text);
    expect(p.collapsible).toBe(true);
    expect(p.preview.split("\n")).toHaveLength(5);
    expect(p.hiddenLines).toBe(15);
  });

  it("folds one very long line", () => {
    const p = planCollapse("x".repeat(2000));
    expect(p.collapsible).toBe(true);
    expect(p.preview.length).toBeLessThanOrEqual(420);
  });

  it("folds harness-injected text even when short", () => {
    const text = "<system-reminder>\nuse the tool\n</system-reminder>";
    expect(isInjectedMessage(text)).toBe(true);
    const p = planCollapse(text);
    expect(p).toMatchObject({ collapsible: true, injected: true });
    expect(p.preview).toBe("use the tool"); // tags stripped, one clean line
  });

  it("recognises the continuation summary as a system message", () => {
    expect(
      isInjectedMessage(
        "This session is being continued from a previous conversation that ran out",
      ),
    ).toBe(true);
  });

  it("does not treat a user quoting a tag mid-message as injected", () => {
    expect(isInjectedMessage("see <system-reminder> in the log")).toBe(false);
  });
});
