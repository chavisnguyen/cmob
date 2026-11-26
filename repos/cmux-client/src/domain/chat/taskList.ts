/**
 * Multi-Agent Task List & Background Work Normalization
 *
 * Unifies task/checklist tools and background jobs + subagents across:
 * - Claude Code: `TodoWrite`, `TaskCreate`, `TaskUpdate`, `Agent`/`Task`, `Bash(run_in_background)`
 * - Antigravity (`agy`): `update_steps`, `invoke_subagent`, background `run_command` (`task-XXXX`)
 * - Codex: `update_plan`, `spawn_agent`
 * - OpenCode: `todowrite`, `task` / `subagent`
 * - Kiro: `sub_agent_start` / `sub_agent_complete`
 *
 * Sources:
 * - ref/orca/src/shared/native-chat/input/native-chat-task-list.ts:1-171
 * - ref/orca/src/shared/native-chat/input/native-chat-task-list-state.ts:36-47
 * - ref/orca/src/shared/background-task-header-content.ts:67-146
 */

import type {
  AgentTurn,
  BackgroundTaskEntry,
  BackgroundTaskKind,
  SubagentEntry,
  SubagentState,
} from "../../protocol/event";

export type ChatTaskStatus = "pending" | "in_progress" | "completed" | "skipped" | "failed";

export interface ChatTaskItem {
  id?: string;
  content: string;
  status: ChatTaskStatus;
  activeForm?: string;
}

export interface ChatTaskList {
  tasks: ChatTaskItem[];
  explanation?: string;
}

export interface InlineTaskSummary {
  headline: string;
  completedCount: number;
  totalCount: number;
  list: ChatTaskList;
}

export interface UnifiedWorkItem {
  id: string;
  kind: BackgroundTaskKind;
  label: string;
  state: SubagentState;
  summary?: string;
  tokens?: number;
  startedAt?: number;
  settledAt?: number;
}

export interface BackgroundWorkGroup {
  kind: BackgroundTaskKind;
  label: string;
  items: UnifiedWorkItem[];
}

export interface BackgroundWorkHeaderSegment {
  kind: BackgroundTaskKind | null;
  text: string;
}

export interface ActiveBackgroundWork {
  groups: BackgroundWorkGroup[];
  segments: BackgroundWorkHeaderSegment[];
  detail: string | null;
  hasLiveWork: boolean;
  totalCount: number;
  workingCount: number;
  clockStartedAt: number | null;
  settledAt: number | null;
}

export interface ConversationTasksSnapshot {
  dockedTaskList: ChatTaskList | null;
  inlineSummaries: Map<string, InlineTaskSummary>;
  backgroundWork: ActiveBackgroundWork | null;
}

const SNAPSHOT_TASK_TOOLS = new Set(["todowrite", "update_plan", "update_steps"]);
const INCREMENTAL_TASK_TOOLS = new Set(["taskcreate", "taskupdate"]);

export function isTaskListToolName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return SNAPSHOT_TASK_TOOLS.has(normalized) || INCREMENTAL_TASK_TOOLS.has(normalized);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJsonValue(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  const first = trimmed[0];
  if (first !== "{" && first !== "[" && first !== '"') return raw;
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function cleanAgyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") {
        trimmed = parsed.trim();
      }
    } catch {
      // keep trimmed
    }
  }
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeTaskStatus(raw: unknown): ChatTaskStatus {
  const s = cleanAgyString(raw)?.toLowerCase();
  switch (s) {
    case "in_progress":
    case "inprogress":
    case "running":
    case "active":
      return "in_progress";
    case "completed":
    case "done":
      return "completed";
    case "skipped":
      return "skipped";
    case "failed":
    case "error":
      return "failed";
    default:
      return "pending";
  }
}

/**
 * Parse full-replace task list tools:
 * - `TodoWrite` / `todowrite`: `{ todos: [{ content, status, activeForm }] }`
 * - `update_plan`: `{ plan: [{ step, status }], explanation }`
 * - `update_steps` (`agy`): `{ steps: [{ title, status }] }` (where `steps` may be a JSON string)
 */
export function parseSnapshotTaskList(name: string, detail?: string): ChatTaskList | null {
  const tool = name.trim().toLowerCase();
  if (!SNAPSHOT_TASK_TOOLS.has(tool) || !detail) {
    return null;
  }
  const root = asRecord(parseJsonValue(detail));
  if (!root) return null;

  let rawEntries: unknown =
    tool === "todowrite" ? root.todos : tool === "update_plan" ? root.plan : root.steps;

  if (typeof rawEntries === "string") {
    rawEntries = parseJsonValue(rawEntries);
  }
  if (!Array.isArray(rawEntries)) {
    return null;
  }

  const tasks: ChatTaskItem[] = [];
  for (const entry of rawEntries) {
    const item = asRecord(entry);
    if (!item) continue;
    const content =
      tool === "todowrite"
        ? cleanAgyString(item.content ?? item.title)
        : tool === "update_plan"
          ? cleanAgyString(item.step ?? item.title ?? item.content)
          : cleanAgyString(item.title ?? item.content ?? item.step);
    if (!content) continue;
    const status = normalizeTaskStatus(item.status);
    const activeForm = cleanAgyString(item.activeForm);
    const id = cleanAgyString(item.id);
    tasks.push({
      ...(id ? { id } : {}),
      content,
      status,
      ...(activeForm ? { activeForm } : {}),
    });
  }

  if (rawEntries.length > 0 && tasks.length === 0) {
    return null;
  }

  const explanation = cleanAgyString(root.explanation);
  return {
    tasks,
    ...(explanation ? { explanation } : {}),
  };
}

function extractCreatedTaskId(resultDetail?: string, fallbackSeq?: number): string {
  if (resultDetail) {
    const hashMatch = resultDetail.match(/Task\s+#?([A-Za-z0-9_-]+)/i);
    if (hashMatch?.[1]) return hashMatch[1];
    const parsed = asRecord(parseJsonValue(resultDetail));
    const jsonId =
      cleanAgyString(parsed?.id) ??
      cleanAgyString(parsed?.taskId) ??
      cleanAgyString(asRecord(parsed?.task)?.id);
    if (jsonId) return jsonId;
  }
  return String(fallbackSeq ?? 1);
}

function applyIncrementalTaskTool(
  name: string,
  inputDetail: string | undefined,
  resultDetail: string | undefined,
  current: ChatTaskItem[],
  nextSeq: () => number,
): ChatTaskList | null {
  const tool = name.trim().toLowerCase();
  if (!INCREMENTAL_TASK_TOOLS.has(tool) || !inputDetail) return null;
  const root = asRecord(parseJsonValue(inputDetail));
  if (!root) return null;

  if (tool === "taskcreate") {
    const content =
      cleanAgyString(root.subject) ??
      cleanAgyString(root.title) ??
      cleanAgyString(root.content) ??
      cleanAgyString(root.description);
    if (!content) return null;
    const id = extractCreatedTaskId(resultDetail, nextSeq());
    const status = normalizeTaskStatus(root.status);
    const activeForm = cleanAgyString(root.activeForm);
    const next = [...current, { id, content, status, ...(activeForm ? { activeForm } : {}) }];
    return { tasks: next };
  }

  if (tool === "taskupdate") {
    const targetId = cleanAgyString(root.taskId) ?? cleanAgyString(root.id);
    if (!targetId) return null;
    const rawStatus = cleanAgyString(root.status)?.toLowerCase();
    if (rawStatus === "deleted") {
      return { tasks: current.filter((item) => item.id !== targetId) };
    }
    const nextSubject = cleanAgyString(root.subject) ?? cleanAgyString(root.title);
    const nextActiveForm = cleanAgyString(root.activeForm);
    const hasStatus = rawStatus !== undefined;
    let matched = false;
    const next = current.map((item, idx) => {
      const itemId = item.id ?? String(idx + 1);
      if (itemId !== targetId) return item;
      matched = true;
      return {
        ...item,
        id: itemId,
        ...(nextSubject ? { content: nextSubject } : {}),
        ...(hasStatus ? { status: normalizeTaskStatus(rawStatus) } : {}),
        ...(nextActiveForm ? { activeForm: nextActiveForm } : {}),
      };
    });
    if (!matched && nextSubject) {
      next.push({
        id: targetId,
        content: nextSubject,
        status: hasStatus ? normalizeTaskStatus(rawStatus) : "pending",
        ...(nextActiveForm ? { activeForm: nextActiveForm } : {}),
      });
    } else if (!matched) {
      return null;
    }
    return { tasks: next };
  }

  return null;
}

export function completedTaskCount(list: ChatTaskList): number {
  return list.tasks.filter((t) => t.status === "completed" || t.status === "skipped").length;
}

export function taskDisplayLabel(task: ChatTaskItem): string {
  return task.status === "in_progress" && task.activeForm ? task.activeForm : task.content;
}

function summarizeTaskTransition(
  previous: ChatTaskList | null,
  current: ChatTaskList,
): InlineTaskSummary {
  const completedCount = completedTaskCount(current);
  const totalCount = current.tasks.length;
  if (totalCount === 0) {
    return {
      headline: "Cleared task list",
      completedCount: 0,
      totalCount: 0,
      list: current,
    };
  }

  const inProgress = current.tasks.find((t) => t.status === "in_progress");
  if (!previous || previous.tasks.length === 0) {
    const lead = inProgress
      ? `Started ${taskDisplayLabel(inProgress)}`
      : completedCount === totalCount
        ? "Completed all tasks"
        : `Planned ${totalCount} task${totalCount === 1 ? "" : "s"}`;
    return {
      headline: `${lead} (${completedCount}/${totalCount})`,
      completedCount,
      totalCount,
      list: current,
    };
  }

  // Find newly started or newly completed item relative to previous snapshot.
  const prevByContent = new Map<string, ChatTaskStatus>();
  for (const t of previous.tasks) {
    if (!prevByContent.has(t.content)) {
      prevByContent.set(t.content, t.status);
    }
  }

  const newlyStarted = current.tasks.find(
    (t) => t.status === "in_progress" && prevByContent.get(t.content) !== "in_progress",
  );
  if (newlyStarted) {
    return {
      headline: `Started ${taskDisplayLabel(newlyStarted)} (${completedCount}/${totalCount})`,
      completedCount,
      totalCount,
      list: current,
    };
  }

  const newlyCompleted = [...current.tasks]
    .reverse()
    .find((t) => t.status === "completed" && prevByContent.get(t.content) !== "completed");
  if (newlyCompleted) {
    const lead =
      completedCount === totalCount && !inProgress
        ? `Completed all ${totalCount} tasks`
        : `Completed ${newlyCompleted.content}`;
    return {
      headline:
        completedCount === totalCount && !inProgress
          ? lead
          : `${lead} (${completedCount}/${totalCount})`,
      completedCount,
      totalCount,
      list: current,
    };
  }

  const fallbackLead = inProgress ? taskDisplayLabel(inProgress) : "Updated tasks";
  return {
    headline: `${fallbackLead} (${completedCount}/${totalCount})`,
    completedCount,
    totalCount,
    list: current,
  };
}

export function formatChatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const mins = Math.floor(s / 60);
  const remSecs = s % 60;
  if (mins < 60) {
    return remSecs === 0 ? `${mins}m` : `${mins}m ${String(remSecs).padStart(2, "0")}s`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${String(remMins).padStart(2, "0")}m`;
}

export function formatWorkTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens} tok`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k tok`;
  return `${(tokens / 1_000_000).toFixed(1)}M tok`;
}

const KIND_ORDER: readonly BackgroundTaskKind[] = [
  "agent",
  "command",
  "workflow",
  "monitor",
  "unknown",
];

function groupTitleForKind(kind: BackgroundTaskKind): string {
  switch (kind) {
    case "agent":
      return "Subagents";
    case "command":
      return "Background Shell";
    case "workflow":
      return "Workflows";
    case "monitor":
      return "Monitors";
    case "unknown":
      return "Background Tasks";
  }
}

function kindCountPhrase(kind: BackgroundTaskKind, count: number): string {
  switch (kind) {
    case "agent":
      return `${count} subagent${count === 1 ? "" : "s"}`;
    case "command":
      return count === 1 ? "1 shell job" : `${count} shell jobs`;
    case "workflow":
      return `${count} workflow${count === 1 ? "" : "s"}`;
    case "monitor":
      return `${count} monitor${count === 1 ? "" : "s"}`;
    case "unknown":
      return `${count} task${count === 1 ? "" : "s"}`;
  }
}

function isWorkingState(state: SubagentState): boolean {
  return state === "working";
}

function buildActiveBackgroundWork(turns: readonly AgentTurn[]): ActiveBackgroundWork | null {
  if (turns.length === 0) return null;

  const byKey = new Map<string, { item: UnifiedWorkItem; turnIdx: number }>();

  for (let tIdx = 0; tIdx < turns.length; tIdx++) {
    const turn = turns[tIdx];
    for (const ev of turn.events) {
      if (ev.kind === "subagents") {
        for (const a of ev.agents) {
          byKey.set(`agent:${a.id}`, {
            turnIdx: tIdx,
            item: {
              id: a.id,
              kind: "agent",
              label: a.label || a.id,
              state: a.state,
              tokens: a.tokens,
              startedAt: a.started_at ?? turn.timestamp,
              settledAt: a.settled_at,
            },
          });
        }
      } else if (ev.kind === "background-tasks") {
        for (const task of ev.tasks) {
          byKey.set(`bg:${task.id}`, {
            turnIdx: tIdx,
            item: {
              id: task.id,
              kind: task.kind,
              label: task.label || task.id,
              state: task.state,
              summary: task.summary,
              tokens: task.tokens,
              startedAt: task.started_at ?? turn.timestamp,
              settledAt: task.settled_at,
            },
          });
        }
      }
    }
  }

  if (byKey.size === 0) return null;

  const allEntries = Array.from(byKey.values());
  const hasAnyLive = allEntries.some((e) => isWorkingState(e.item.state));
  if (!hasAnyLive) return null;

  // Keep siblings from the same turn visible alongside any still-working item so progress like
  // "2 subagents — 1 working, 1 done" reads coherently while in flight, then auto-hide the entire
  // strip immediately once all subagents and background jobs finish.
  const liveTurns = new Set(
    allEntries.filter((e) => isWorkingState(e.item.state)).map((e) => e.turnIdx),
  );
  const visibleItems = allEntries
    .filter((e) => isWorkingState(e.item.state) || liveTurns.has(e.turnIdx))
    .map((e) => e.item);

  if (visibleItems.length === 0) return null;

  const groups: BackgroundWorkGroup[] = [];
  for (const kind of KIND_ORDER) {
    const items = visibleItems.filter((i) => i.kind === kind);
    if (items.length > 0) {
      groups.push({ kind, label: groupTitleForKind(kind), items });
    }
  }

  const workingCount = visibleItems.filter((i) => i.state === "working").length;
  const doneCount = visibleItems.filter((i) => i.state === "completed").length;
  const failedCount = visibleItems.filter((i) => i.state === "failed").length;
  const stoppedCount = visibleItems.filter((i) => i.state === "stopped").length;

  const segments: BackgroundWorkHeaderSegment[] =
    groups.length <= 3
      ? groups.map((g) => ({
          kind: g.kind,
          text:
            g.items.length === 1 && groups.length === 1
              ? g.items[0].label
              : kindCountPhrase(g.kind, g.items.length),
        }))
      : [{ kind: null, text: `${visibleItems.length} background tasks` }];

  const statusParts: string[] = [];
  if (workingCount > 0) {
    statusParts.push(visibleItems.length === 1 ? "running" : `${workingCount} working`);
  }
  if (failedCount > 0) {
    statusParts.push(visibleItems.length === 1 ? "failed" : `${failedCount} failed`);
  }
  if (doneCount > 0) {
    statusParts.push(visibleItems.length === 1 ? "done" : `${doneCount} done`);
  }
  if (stoppedCount > 0) {
    statusParts.push(visibleItems.length === 1 ? "stopped" : `${stoppedCount} stopped`);
  }

  const startedCandidates = visibleItems
    .map((i) => i.startedAt)
    .filter((t): t is number => typeof t === "number" && t > 0);
  const clockStartedAt = startedCandidates.length > 0 ? Math.min(...startedCandidates) : null;

  const settledCandidates = visibleItems
    .map((i) => i.settledAt)
    .filter((t): t is number => typeof t === "number" && t > 0);
  const settledAt =
    workingCount === 0 && settledCandidates.length > 0 ? Math.max(...settledCandidates) : null;

  return {
    groups,
    segments,
    detail: statusParts.length > 0 ? statusParts.join(", ") : null,
    hasLiveWork: workingCount > 0,
    totalCount: visibleItems.length,
    workingCount,
    clockStartedAt,
    settledAt,
  };
}

/**
 * Computes the conversation's docked checklist, per-tool inline summaries, and active
 * subagent/background-job strip model from the current turns array.
 */
export function deriveConversationTasks(
  turns: readonly AgentTurn[],
  _isSessionWorking = false,
): ConversationTasksSnapshot {
  const inlineSummaries = new Map<string, InlineTaskSummary>();
  let latestSnapshot: ChatTaskList | null = null;
  let incrementalItems: ChatTaskItem[] = [];
  let incrementalSeq = 0;

  for (let tIdx = 0; tIdx < turns.length; tIdx++) {
    const turn = turns[tIdx];
    if (turn.role === "user" || turn.role === "system") continue;

    // Pair ToolEnd results by tool_id within this turn so rejected/failed calls are skipped.
    const endById = new Map<string, { ok: boolean; detail?: string }>();
    for (const ev of turn.events) {
      if (ev.kind === "tool-end") {
        endById.set(ev.tool_id, { ok: ev.ok !== false, detail: ev.detail });
      }
    }

    for (const ev of turn.events) {
      if (ev.kind !== "tool-start") continue;
      if (!isTaskListToolName(ev.name)) continue;
      const end = endById.get(ev.tool_id);
      if (end && !end.ok) continue;

      const lower = ev.name.trim().toLowerCase();
      let nextList: ChatTaskList | null = null;
      if (SNAPSHOT_TASK_TOOLS.has(lower)) {
        nextList = parseSnapshotTaskList(ev.name, ev.detail);
        if (nextList) {
          incrementalItems = nextList.tasks.map((t, idx) => ({
            ...t,
            id: t.id ?? String(idx + 1),
          }));
        }
      } else if (INCREMENTAL_TASK_TOOLS.has(lower)) {
        nextList = applyIncrementalTaskTool(
          ev.name,
          ev.detail,
          end?.detail,
          incrementalItems,
          () => {
            incrementalSeq += 1;
            return incrementalSeq;
          },
        );
        if (nextList) {
          incrementalItems = nextList.tasks;
        }
      }

      if (nextList) {
        const summary = summarizeTaskTransition(latestSnapshot, nextList);
        inlineSummaries.set(ev.tool_id, summary);
        latestSnapshot = nextList;
      }
    }
  }

  // Auto-hide 100%-completed checklists from the composer tray immediately once finished;
  // inline tool summaries inside the conversation timeline still preserve the 3/3 record.
  const allCompleted =
    latestSnapshot !== null &&
    latestSnapshot.tasks.length > 0 &&
    completedTaskCount(latestSnapshot) >= latestSnapshot.tasks.length;
  const dockedTaskList =
    latestSnapshot && latestSnapshot.tasks.length > 0 && !allCompleted ? latestSnapshot : null;
  const backgroundWork = buildActiveBackgroundWork(turns);

  return {
    dockedTaskList,
    inlineSummaries,
    backgroundWork,
  };
}

/** Reuse helper for rendering a single checklist block cleanly across inline & docked views. */
export function taskStatusBadgeLabel(status: ChatTaskStatus): string {
  switch (status) {
    case "completed":
      return "done";
    case "in_progress":
      return "active";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    default:
      return "pending";
  }
}

/**
 * Self-contained inline summary for a single task-tool call inside `MobileNativeChatToolRun`
 * so `ChatTurnRow` stays purely memoized on `turn` without extra cross-turn props.
 */
export function describeTaskToolCall(
  name: string,
  inputDetail?: string,
): { headline: string; list: ChatTaskList | null } | null {
  if (!isTaskListToolName(name)) return null;
  const snapshot = parseSnapshotTaskList(name, inputDetail);
  if (snapshot) {
    const done = completedTaskCount(snapshot);
    const total = snapshot.tasks.length;
    if (total === 0) {
      return { headline: "Cleared task list", list: snapshot };
    }
    const active = snapshot.tasks.find((t) => t.status === "in_progress");
    const lead = active
      ? taskDisplayLabel(active)
      : done === total
        ? "Completed all tasks"
        : "Updated tasks";
    return {
      headline: `${lead} (${done}/${total})`,
      list: snapshot,
    };
  }

  const lower = name.trim().toLowerCase();
  const root = inputDetail ? asRecord(parseJsonValue(inputDetail)) : null;
  if (lower === "taskcreate" && root) {
    const subject =
      cleanAgyString(root.subject) ?? cleanAgyString(root.title) ?? cleanAgyString(root.content);
    return {
      headline: subject ? `Added task: ${subject}` : "Created task",
      list: null,
    };
  }
  if (lower === "taskupdate" && root) {
    const id = cleanAgyString(root.taskId) ?? cleanAgyString(root.id);
    const st = cleanAgyString(root.status);
    const subject = cleanAgyString(root.subject) ?? cleanAgyString(root.title);
    const target = subject ?? (id ? `task #${id}` : "task");
    return {
      headline: st ? `Updated ${target} → ${st}` : `Updated ${target}`,
      list: null,
    };
  }
  return null;
}

export type { BackgroundTaskEntry, SubagentEntry };
