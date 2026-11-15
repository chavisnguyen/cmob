/**
 * JSON-RPC 2.0 Wire Protocol Definitions for cmux-mobile
 * Source: ref/cmux-pocket/crates/cmux-pocket-protocol/src/rpc.rs
 */

export const CODE_PARSE_ERROR = -32700;
export const CODE_INVALID_REQUEST = -32600;
export const CODE_METHOD_NOT_FOUND = -32601;
export const CODE_INVALID_PARAMS = -32602;
export const CODE_INTERNAL_ERROR = -32603;
export const CODE_BACKEND_UNAVAILABLE = -32000;

export const RPC_METHODS = {
  CHAT_SESSIONS: "mobile.chat.sessions",
  CHAT_READ_SESSION: "mobile.chat.readSession",
  CHAT_SUBSCRIBE: "mobile.chat.subscribe",
  CHAT_UNSUBSCRIBE: "mobile.chat.unsubscribe",
  CHAT_SEND: "mobile.chat.send",
  CHAT_APPROVE: "mobile.chat.approve",
  CHAT_INTERRUPT: "mobile.chat.interrupt",
  CHAT_ANSWER_DIALOG: "mobile.chat.answerDialog",
  HOST_STATUS: "mobile.host.status",
  WORKSPACE_LIST: "mobile.workspace.list",
  WORKSPACE_TREE: "mobile.workspace.tree",
  SURFACE_GET: "mobile.surface.get",
  PUSH_REGISTER: "mobile.push.register",
  PUSH_TEST: "mobile.push.test",
  PUSH_VAPID_KEY: "mobile.push.vapidKey",
  PUSH_HISTORY: "mobile.push.history",
  PUSH_PREFERENCES: "mobile.push.preferences",
  CHAT_FORK: "mobile.chat.fork",
  CHAT_SET_OPTION: "mobile.chat.setOption",
  AGENT_OPTIONS: "mobile.agent.options",
  UPLOAD_IMAGE: "mobile.upload.image",
  GIT_STATUS: "mobile.git.status",
  GIT_DIFF: "mobile.git.diff",
  DEVICE_LIST: "mobile.device.list",
  DEVICE_REVOKE: "mobile.device.revoke",
  SURFACE_NEW: "mobile.surface.new",
  SURFACE_CLOSE: "mobile.surface.close",
  SURFACE_RENAME: "mobile.surface.rename",
  TERMINAL_READ: "mobile.terminal.read",
  TERMINAL_SEND: "mobile.terminal.send",
  TERMINAL_REPLAY: "mobile.terminal.replay",
  TERMINAL_VIEWPORT: "mobile.terminal.viewport",
  TERMINAL_INPUT: "mobile.terminal.input",
  TERMINAL_PASTE: "mobile.terminal.paste",
  TERMINAL_SCROLL: "mobile.terminal.scroll",
  TERMINAL_SUBSCRIBE: "mobile.terminal.subscribe",
  TERMINAL_UNSUBSCRIBE: "mobile.terminal.unsubscribe",
} as const;

/** Server-push event names (frames carry `event` + `data`, no `id`). */
export const RPC_EVENTS = {
  /** Payload has the same shape as a `mobile.chat.readSession` result. */
  CHAT_UPDATE: "mobile.chat.update",
  TERMINAL_UPDATE: "mobile.terminal.update",
} as const;

export type RpcMethod = (typeof RPC_METHODS)[keyof typeof RPC_METHODS];

export type RequestId = string | number;

export interface JsonRpcRequest<T = unknown> {
  id: RequestId;
  method: string;
  params?: T;
  [key: string]: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
  [key: string]: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  id?: RequestId;
  result?: T;
  error?: JsonRpcError;
  event?: string;
  data?: unknown;
  [key: string]: unknown;
}

let nextRequestId = 1;

export function createRpcRequest<T = Record<string, unknown>>(
  method: string,
  params?: T,
  id: RequestId = `req-${nextRequestId++}`,
): JsonRpcRequest<T> {
  return {
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  };
}

/** Level 1: Workspace matching cmux macOS sidebar */
export interface WorkspaceNode {
  id: string;
  ref: string;
  title: string;
  pinned: boolean;
  selected: boolean;
  status: "running" | "idle" | (string & {});
  current_directory: string;
  /** cmux sidebar color for this workspace (`#RRGGBB`). */
  color?: string;
  snippet?: string;
  surfaces: SurfaceNode[];
}

/** Level 1: Workspace summary */
export interface WorkspaceSummary {
  id: string;
  ref: string;
  title: string;
  pinned: boolean;
  selected: boolean;
  status: "running" | "idle" | (string & {});
  current_directory: string;
  snippet?: string;
  surface_count: number;
  has_running_agent: boolean;
}

/** Level 2: Surface tab */
export interface SurfaceNode {
  id: string;
  ref: string;
  title: string;
  surface_type: "terminal" | "markdown" | "browser" | (string & {});
  tty?: string;
  selected: boolean;
  focused: boolean;
  agent?: SurfaceAgentInfo;
}

/** Level 3: Active AI agent metadata */
export interface SurfaceAgentInfo {
  session_id: string;
  agent_kind: "claude" | "antigravity" | "codex" | "kiro" | (string & {});
  status: "running" | "idle" | (string & {});
  transcript_path?: string;
}

export interface RenderGridCursor {
  blinking?: boolean;
  column: number;
  row: number;
  style?: "block" | "bar" | "underline" | (string & {});
  visible?: boolean;
}

export interface RenderGridMode {
  ansi: boolean;
  code: number;
  on: boolean;
}

export interface RenderGridStyle {
  id: number;
  foreground?: string;
  foreground_source?: string;
  background?: string;
  background_source?: string;
  bold?: boolean;
  faint?: boolean;
  italic?: boolean;
  underline?: boolean;
  blink?: boolean;
  inverse?: boolean;
  invisible?: boolean;
  strikethrough?: boolean;
  overline?: boolean;
}

export interface RenderGridSpan {
  row: number;
  column: number;
  cell_width?: number;
  style_id: number;
  text: string;
}

export interface RenderGridTheme {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorText?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  palette?: string[];
}

export interface RenderGridData {
  format?: string;
  active_screen: "primary" | "alternate" | (string & {});
  columns: number;
  rows: number;
  scrollback_rows?: number;
  history_rows?: number;
  render_epoch?: string;
  render_revision?: number;
  row_space_revision?: number;
  state_seq?: number;
  cursor?: RenderGridCursor;
  modes?: RenderGridMode[];
  styles?: RenderGridStyle[];
  row_spans?: RenderGridSpan[];
  scrollback_spans?: RenderGridSpan[];
  terminal_theme?: RenderGridTheme;
  terminal_background?: string;
  terminal_foreground?: string;
}

export interface TerminalSizeParticipant {
  id: string;
  device_kind?: string;
  counts?: boolean;
  viewport?: { cols: number; rows: number };
}

export interface TerminalSizeState {
  cols: number;
  rows: number;
  reason?: string;
  owners?: string[];
  participants?: TerminalSizeParticipant[];
}

export interface TerminalReplayPayload {
  surface_id: string;
  workspace_id?: string;
  columns: number;
  rows: number;
  mode?: "mobile" | "desktop" | (string & {});
  size_state?: TerminalSizeState;
  render_grid?: RenderGridData;
}
