import { describe, expect, it } from "vite-plus/test";
import { displaySurfaceTitle } from "./surfaceTitle";

describe("displaySurfaceTitle", () => {
  it("keeps the last two segments of a path title", () => {
    expect(displaySurfaceTitle("/Users/me/personal/product/cmux-mobile")).toBe(
      "…/product/cmux-mobile",
    );
    expect(displaySurfaceTitle(".../personal/product/cmux-mobile")).toBe("…/product/cmux-mobile");
    expect(displaySurfaceTitle("…/personal/product/cmux-mobile")).toBe("…/product/cmux-mobile");
  });
  it("leaves normal titles and short paths alone", () => {
    expect(displaySurfaceTitle("Dự án so với Orca")).toBe("Dự án so với Orca");
    expect(displaySurfaceTitle("~/work")).toBe("~/work");
    expect(displaySurfaceTitle("")).toBe("Tab");
  });
});
