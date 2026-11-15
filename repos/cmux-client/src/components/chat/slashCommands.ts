/**
 * Slash-command suggestions for the composer.
 *
 * Data copied from Orca's curated lists, since the agent CLIs expose no machine-readable catalog:
 * ref/orca/src/shared/native-chat/input/native-chat-slash-commands.ts (COMMON :26-29, CLAUDE :31-37,
 * OPENCLAUDE :40-43, CODEX :45-62, lookup with COMMON fallback :90-130). Only agents that list has
 * entries for get a specific menu; every other agent gets the small common set, as in Orca.
 * Selecting a suggestion only fills the composer; the agent's own TUI interprets the command.
 */

export interface SlashCommand {
  /** Command name without the leading slash. */
  name: string;
  description: string;
}

const COMMON: readonly SlashCommand[] = [
  { name: "clear", description: "Clear the conversation" },
  { name: "help", description: "Show available commands" },
];

const CLAUDE: readonly SlashCommand[] = [
  { name: "clear", description: "Clear conversation history" },
  { name: "compact", description: "Summarize and compact the conversation" },
  { name: "init", description: "Initialize a CLAUDE.md" },
  { name: "review", description: "Review the current changes" },
  { name: "help", description: "Show available commands" },
];

const CODEX: readonly SlashCommand[] = [
  { name: "model", description: "Choose the model and reasoning effort" },
  { name: "ide", description: "Include IDE context" },
  { name: "permissions", description: "Choose what Codex is allowed to do" },
  { name: "keymap", description: "Remap TUI shortcuts" },
  { name: "vim", description: "Toggle Vim mode" },
  { name: "experimental", description: "Toggle experimental features" },
  { name: "approve", description: "Approve one auto-review retry" },
  { name: "memories", description: "Configure memory use" },
  { name: "skills", description: "Manage and use skills" },
  { name: "import", description: "Import setup from Claude Code" },
  { name: "hooks", description: "View lifecycle hooks" },
  { name: "review", description: "Review the current changes" },
  { name: "rename", description: "Rename the current thread" },
  { name: "new", description: "Start a new chat" },
  { name: "archive", description: "Archive this session and exit" },
  { name: "subagents", description: "Switch the active agent thread" },
];

export function slashCommandsFor(agentKind: string | null | undefined): readonly SlashCommand[] {
  const k = (agentKind ?? "").toLowerCase();
  if (k === "claude" || k === "openclaude") return CLAUDE;
  if (k === "codex") return CODEX;
  return COMMON;
}

/**
 * Suggestions for the current composer text. Active only while the text is a single `/token` with no
 * whitespace yet (so typing arguments dismisses the menu). Prefix matches first, then substring.
 */
export function suggestSlashCommands(
  agentKind: string | null | undefined,
  input: string,
  limit = 6,
): SlashCommand[] {
  if (!input.startsWith("/") || /\s/.test(input)) return [];
  const query = input.slice(1).toLowerCase();
  const all = slashCommandsFor(agentKind);
  const prefix = all.filter((c) => c.name.startsWith(query));
  const rest = all.filter((c) => !c.name.startsWith(query) && c.name.includes(query));
  return [...prefix, ...rest].slice(0, limit);
}
