/**
 * Model / effort options of an agent (data comes from the gateway: `mobile.agent.options`).
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
  mid_session: "command" | "picker";
}

const OPTION_AGENTS = new Set([
  "claude",
  "claude-code",
  "openclaude",
  "codex",
  "antigravity",
  "agy",
]);

export function hasAgentOptions(agentKind: string | null | undefined): boolean {
  return OPTION_AGENTS.has((agentKind ?? "").trim().toLowerCase());
}

/** Effort levels offered specifically for `modelId`; an unknown model returns `[]`. */
export function effortsFor(
  info: AgentOptionsInfo,
  modelId: string | null | undefined,
): EffortChoice[] {
  return info.models.find((m) => m.id === modelId)?.efforts ?? [];
}

/** Widest effort set across all models in `info`, used when current model id is unset/unlisted. */
export function widestEfforts(info: AgentOptionsInfo): EffortChoice[] {
  let best: EffortChoice[] = [];
  for (const m of info.models) {
    if (m.efforts.length > best.length) {
      best = m.efforts;
    }
  }
  return best;
}

/** Resolves active model selection: `chosenModel` > transcript `currentModel` match > `default_model`. */
export function resolveSelectedModel(
  info: AgentOptionsInfo | null | undefined,
  chosenModel: string | null,
  currentModel?: string | null,
): string | null {
  if (chosenModel) return chosenModel;
  if (!info) return null;
  if (currentModel) {
    const normCurrent = currentModel.toLowerCase();
    const exactOrSub = info.models.find(
      (m) => normCurrent === m.id.toLowerCase() || normCurrent.includes(m.id.toLowerCase()),
    );
    if (exactOrSub) return exactOrSub.id;
  }
  if (info.default_model) {
    const def = info.models.find((m) => m.id === info.default_model);
    return def ? def.id : info.default_model;
  }
  return null;
}

/**
 * Efforts shown in `AgentOptionsSheet`: uses the selected model's efforts when `selectedModel` is
 * a known catalog entry, or falls back to `widestEfforts(info)` when no catalog model matched yet.
 */
export function resolveDisplayedEfforts(
  info: AgentOptionsInfo,
  selectedModel: string | null | undefined,
): EffortChoice[] {
  if (selectedModel) {
    const matched = info.models.find((m) => m.id === selectedModel);
    if (matched) return matched.efforts;
  }
  return widestEfforts(info);
}

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

export function launchChoice(
  agentKind: string,
  model: string | null,
  effort: string | null,
): LaunchChoice | undefined {
  if (!model && !effort) return undefined;
  return { agent_kind: agentKind, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}
