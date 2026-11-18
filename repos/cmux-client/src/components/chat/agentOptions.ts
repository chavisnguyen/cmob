/**
 * Model / effort options of an agent (data comes from the gateway: `mobile.agent.options`, built from Orca's
 * per-agent catalog, see gateway cmux/agent_options.rs).
 */

export interface EffortChoice {
  value: string;
  label: string;
}

export interface ModelOption {
  id: string;
  label: string;
  description?: string;
  efforts: EffortChoice[];
  /** `/fast` toggle (Claude Opus). */
  fast: boolean;
}

export interface AgentOptionsInfo {
  agent_kind: string;
  models: ModelOption[];
  default_model?: string;
  default_effort?: string;
  /** `command`: applied by typing a slash command. `picker`: the agent shows its own picker (answer in terminal). */
  mid_session: "command" | "picker";
}

/** Agents that have an option catalog in the gateway (the gateway decides; this only hides the button). */
const OPTION_AGENTS = new Set(["claude", "openclaude", "codex", "antigravity"]);

export function hasAgentOptions(agentKind: string | null | undefined): boolean {
  return OPTION_AGENTS.has((agentKind ?? "").toLowerCase());
}

/** Effort levels offered for `modelId`; an unknown model offers nothing (the gateway still accepts it). */
export function effortsFor(
  info: AgentOptionsInfo,
  modelId: string | null | undefined,
): EffortChoice[] {
  return info.models.find((m) => m.id === modelId)?.efforts ?? [];
}

/** After switching model, keep the effort if the new model supports it, otherwise drop it. */
export function effortAfterModelChange(
  info: AgentOptionsInfo,
  newModelId: string,
  currentEffort: string | null,
): string | null {
  if (!currentEffort) return null;
  return effortsFor(info, newModelId).some((e) => e.value === currentEffort) ? currentEffort : null;
}

export interface LaunchChoice {
  agent_kind: string;
  model?: string;
  effort?: string;
}

/** `launch` payload for `mobile.surface.new`, or undefined when nothing was chosen. */
export function launchChoice(
  agentKind: string,
  model: string | null,
  effort: string | null,
): LaunchChoice | undefined {
  if (!model && !effort) return undefined;
  return { agent_kind: agentKind, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}
