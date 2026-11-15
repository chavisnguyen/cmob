import { describe, expect, it } from "vite-plus/test";
import { agentBrand, agentDisplayName } from "./agentBrand";

describe("agentBrand", () => {
  it("maps gateway agent kinds and aliases to a brand", () => {
    expect(agentBrand("claude")).toBe("claude");
    expect(agentBrand("openclaude")).toBe("claude");
    expect(agentBrand("codex")).toBe("codex");
    expect(agentBrand("antigravity")).toBe("antigravity");
    expect(agentBrand("agys")).toBe("antigravity");
    expect(agentBrand("kiro")).toBe("kiro");
    expect(agentBrand("kiro-cli")).toBe("kiro");
  });

  it("returns null for unknown agents so the neutral glyph is used", () => {
    expect(agentBrand("opencode")).toBeNull();
    expect(agentBrand(undefined)).toBeNull();
    expect(agentBrand("")).toBeNull();
  });

  it("has display names", () => {
    expect(agentDisplayName("antigravity")).toBe("Antigravity");
    expect(agentDisplayName("codex")).toBe("Codex");
    expect(agentDisplayName("something")).toBe("something");
    expect(agentDisplayName(undefined)).toBe("Agent");
  });
});
