/** Map gateway `agent_kind` / preset ids onto a known coding-agent brand (see AgentIcon.tsx). */

export type AgentBrand = "claude" | "codex" | "antigravity" | "kiro" | "opencode";

/** Map gateway `agent_kind` / preset ids onto a brand. */
export function agentBrand(kind: string | null | undefined): AgentBrand | null {
  const k = (kind ?? "").toLowerCase();
  if (k === "openclaude" || k.startsWith("claude")) return "claude";
  if (k === "codex") return "codex";
  if (k === "agy" || k === "agys" || k.startsWith("antigravity")) return "antigravity";
  if (k.startsWith("kiro")) return "kiro";
  if (k.startsWith("opencode")) return "opencode";
  return null;
}

const DISPLAY_NAME: Record<AgentBrand, string> = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  kiro: "Kiro",
  opencode: "OpenCode",
};

export function agentDisplayName(kind: string | null | undefined): string {
  const brand = agentBrand(kind);
  return brand ? DISPLAY_NAME[brand] : kind || "Agent";
}
