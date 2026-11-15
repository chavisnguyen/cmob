import { describe, expect, it } from "vite-plus/test";
import {
  effortAfterModelChange,
  effortsFor,
  hasAgentOptions,
  launchChoice,
  type AgentOptionsInfo,
} from "./agentOptions";

const E = (...v: string[]) => v.map((value) => ({ value, label: value }));
const info: AgentOptionsInfo = {
  agent_kind: "claude",
  mid_session: "command",
  models: [
    { id: "opus", label: "Opus", efforts: E("low", "medium", "high", "xhigh", "max"), fast: true },
    { id: "haiku", label: "Haiku", efforts: [], fast: false },
  ],
};

describe("agent options", () => {
  it("knows which agents have a catalog", () => {
    expect(hasAgentOptions("claude")).toBe(true);
    expect(hasAgentOptions("Codex")).toBe(true);
    expect(hasAgentOptions("kiro")).toBe(false);
    expect(hasAgentOptions(undefined)).toBe(false);
  });

  it("offers efforts per model only", () => {
    expect(effortsFor(info, "opus").map((e) => e.value)).toContain("max");
    expect(effortsFor(info, "haiku")).toEqual([]);
    expect(effortsFor(info, "unknown-model")).toEqual([]);
  });

  it("keeps a compatible effort across a model change and drops an unsupported one", () => {
    expect(effortAfterModelChange(info, "opus", "high")).toBe("high");
    expect(effortAfterModelChange(info, "haiku", "high")).toBeNull();
    expect(effortAfterModelChange(info, "opus", null)).toBeNull();
  });

  it("builds the launch payload only when something was chosen", () => {
    expect(launchChoice("claude", null, null)).toBeUndefined();
    expect(launchChoice("claude", "sonnet", null)).toEqual({
      agent_kind: "claude",
      model: "sonnet",
    });
    expect(launchChoice("codex", "gpt-5.5", "high")).toEqual({
      agent_kind: "codex",
      model: "gpt-5.5",
      effort: "high",
    });
  });
});
