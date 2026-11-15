/** Map gateway `agent_kind` / preset ids onto a known coding-agent brand (see AgentIcon.tsx). */

export type AgentBrand = "claude" | "codex" | "antigravity" | "kiro";

/** Map gateway `agent_kind` / preset ids onto a brand. */
export function agentBrand(kind: string | null | undefined): AgentBrand | null {
  const k = (kind ?? "").toLowerCase();
  if (k === "openclaude" || k.startsWith("claude")) return "claude";
  if (k === "codex") return "codex";
  if (k === "agy" || k === "agys" || k.startsWith("antigravity")) return "antigravity";
  if (k.startsWith("kiro")) return "kiro";
  return null;
}

const DISPLAY_NAME: Record<AgentBrand, string> = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  kiro: "Kiro",
};

export function agentDisplayName(kind: string | null | undefined): string {
  const brand = agentBrand(kind);
  return brand ? DISPLAY_NAME[brand] : kind || "Agent";
}
