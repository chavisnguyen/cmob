import type {
  AgentLifecycleState,
  AgentTurn,
  AwaitingInput,
  BackgroundTaskEntry,
  StartupDialogInfo,
  SubagentEntry,
} from "../../protocol/event";

export interface ToolCallItem {
  id: string;
  name: string;
  inputDetail?: string;
  detail?: string;
  ok?: boolean;
  isEnd?: boolean;
}

export interface QueuedMessage {
  id: string;
  text: string;
  /** Paths of images already uploaded to the host, pasted before the text when it is sent. */
  images: string[];
}

export interface PendingSendItem {
  id: string;
  text: string;
  /** Normalized comparable prompt text (stripped of XML envelopes and image placeholders). */
  normalizedText: string;
  /** How many user turns already matched `normalizedText` when this send was initiated. */
  baseline: number;
  /** ID of the last turn in the session when this send was initiated (detects newer assistant replies). */
  baselineLastTurnId: string | null;
  /** Total assistant turns present when this send was initiated. */
  baselineAssistantCount: number;
  createdAt: number;
  /** Preview URLs for attached images on optimistic bubbles. */
  imagePreviews?: string[];
}

export interface WireSessionFrame {
  update_kind?: "snapshot" | "delta";
  turns?: AgentTurn[];
  after_turn_id?: string;
  tail_turns?: AgentTurn[];
  agent_kind?: string;
  session_id?: string;
  is_working?: boolean;
  lifecycle_state?: AgentLifecycleState;
  last_event?: string;
  last_subtitle?: string;
  awaiting_prompt?: string | null;
  activity?: string | null;
  surface_id?: string;
  startup_dialog?: StartupDialogInfo | null;
  has_more?: boolean;
  before_offset?: number | null;
  total_turns?: number;
}

export interface ThoughtStepItem {
  id: string;
  text: string;
  durationSeconds?: number;
}

export type WorkRunStepItem =
  | { kind: "thinking"; thought: ThoughtStepItem }
  | { kind: "tool"; tool: ToolCallItem };

export interface WorkRunBlock {
  kind: "work-run";
  key: string;
  steps: WorkRunStepItem[];
  tools: ToolCallItem[];
  thoughts: ThoughtStepItem[];
  totalThoughtSeconds: number;
  live: boolean;
}

export interface LiveReasoningBlock {
  kind: "live-reasoning";
  key: string;
  id: string;
  text: string;
  durationSeconds?: number;
  live: boolean;
}

export interface ProseBlock {
  kind: "prose";
  key: string;
  text: string;
}

export interface SubagentsBlock {
  kind: "subagents";
  key: string;
  groupId: string;
  agents: SubagentEntry[];
}

export interface BackgroundTasksBlock {
  kind: "background-tasks";
  key: string;
  tasks: BackgroundTaskEntry[];
}

export interface AwaitingInputBlock {
  kind: "awaiting-input";
  key: string;
  eventIdx: number;
  awaiting: AwaitingInput;
  pending: boolean;
}

export interface StatusBlock {
  kind: "status";
  key: string;
  text: string;
}

export interface ErrorBlock {
  kind: "error";
  key: string;
  message: string;
}

export type AssistantBlockItem =
  | WorkRunBlock
  | LiveReasoningBlock
  | ProseBlock
  | SubagentsBlock
  | BackgroundTasksBlock
  | AwaitingInputBlock
  | StatusBlock
  | ErrorBlock;

export type ChatTimelineItem =
  | {
      kind: "divider";
      id: string;
      turn: AgentTurn;
      label: string;
    }
  | {
      kind: "user";
      id: string;
      turn: AgentTurn;
      texts: string[];
      imagePreviews: string[];
      pending: boolean;
    }
  | {
      kind: "assistant";
      id: string;
      turn: AgentTurn;
      blocks: AssistantBlockItem[];
      isLastTurn: boolean;
      isWorking: boolean;
    };

export type ComposerDockState =
  | { kind: "none" }
  | { kind: "startup-dialog"; dialog: StartupDialogInfo }
  | {
      kind: "question";
      awaiting: AwaitingInput;
      promptInstanceKey: string;
    }
  | {
      kind: "permission";
      awaiting: AwaitingInput;
      promptInstanceKey: string;
    };

export interface LiveActivityLineState {
  visible: boolean;
  activityText: string | null;
  stopping: boolean;
}
