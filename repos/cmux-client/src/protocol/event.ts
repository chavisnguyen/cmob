/**
 * Unified Agent Event Model
 * Sources:
 * - ref/orca/src/shared/native-chat/native-chat-types.ts:31-180
 * - ref/cmux/agent-chat/types.ts:1-75
 */

export type AgentRole = "user" | "assistant" | "tool" | "reasoning" | "system";

export type AgentLifecycleState = "idle" | "working" | "waiting" | "done" | "error" | "ready";

export type SubagentState =
  | "working"
  | "idle"
  | "completed"
  | "failed"
  | "stopped"
  | "unverifiable";

export interface SubagentEntry {
  id: string;
  label: string;
  state: SubagentState;
  tokens?: number;
  started_at?: number;
  settled_at?: number;
}

export type BackgroundTaskKind = "agent" | "command" | "workflow" | "monitor" | "unknown";

export interface BackgroundTaskEntry {
  id: string;
  kind: BackgroundTaskKind;
  label: string;
  state: SubagentState;
  summary?: string;
  tokens?: number;
  started_at?: number;
  settled_at?: number;
}

export interface AskQuestionItem {
  question: string;
  options: string[];
  multi_select?: boolean;
}

export interface AwaitingInput {
  input_kind: "permission" | "question" | "options" | "other";
  prompt: string;
  options?: string[];
  default_choice?: string;
  multi_select?: boolean;
  questions?: AskQuestionItem[];
  /** Resolved answer recorded in the transcript (Orca ResolutionReceipt). */
  answered?: string;
}

export type AgentEvent =
  | { kind: "user"; text: string }
  | { kind: "thinking"; text: string; duration_secs?: number }
  | { kind: "tool-start"; tool_id: string; name: string; detail?: string }
  | {
      kind: "tool-end";
      tool_id: string;
      name?: string;
      detail?: string;
      ok?: boolean;
    }
  | { kind: "assistant"; text: string }
  | { kind: "delta"; text: string }
  | { kind: "subagents"; group_id: string; agents: SubagentEntry[] }
  | { kind: "background-tasks"; tasks: BackgroundTaskEntry[] }
  | ({ kind: "awaiting-input" } & AwaitingInput)
  | { kind: "status"; text: string }
  | { kind: "done"; stats?: string }
  | {
      kind: "usage";
      model?: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens?: number;
      cache_creation_tokens?: number;
    }
  | { kind: "error"; message: string };

/** A startup dialog the agent shows before its first prompt (folder trust, update, menus). */
export interface StartupDialogInfo {
  kind: string;
  title: string;
  /** The dialog text the user must read before answering. */
  description: string;
  /** Identity of this dialog; the gateway refuses answers if the screen no longer matches. */
  fingerprint: string;
  /** False when only the terminal can answer it. */
  aimed: boolean;
  /** Options exactly as shown on the agent's screen. */
  choices: { label: string }[];
}

export interface AgentTurn {
  id: string;
  surface_id: string;
  role: AgentRole;
  timestamp?: number;
  events: AgentEvent[];
}
