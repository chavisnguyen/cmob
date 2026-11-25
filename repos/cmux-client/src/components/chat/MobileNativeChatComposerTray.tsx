/**
 * Orca-style Composer Tray Strips (Docked Task List + Background Tasks & Subagents)
 *
 * Docked directly above the prompt composer so users immediately see:
 * 1. Current checklist step (`TodoWrite` / `update_plan` / `update_steps` / `TaskCreate`+`TaskUpdate`)
 *    with `completed/total` progress and expandable full checklist.
 * 2. Active subagents & background shell/workflow/monitor jobs with live elapsed timer,
 *    token counts, and expandable per-item status breakdown.
 *
 * Sources:
 * - ref/orca/mobile/src/session/native-chat/composer/use-mobile-native-chat-composer-tray.ts
 * - ref/orca/mobile/src/session/native-chat/input/MobileNativeChatDockedTaskList.tsx
 * - ref/orca/mobile/src/session/native-chat/input/MobileNativeChatBackgroundTasks.tsx
 */

import { Fragment, memo, useEffect, useState } from "react";
import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleHelp,
  Clock,
  ListChecks,
  MinusCircle,
  SquareTerminal,
  Workflow,
  XCircle,
} from "lucide-react";
import type { BackgroundTaskKind, SubagentState } from "../../protocol/event";
import {
  completedTaskCount,
  formatChatDuration,
  formatWorkTokens,
  taskDisplayLabel,
  type ActiveBackgroundWork,
  type ChatTaskItem,
  type ChatTaskList,
  type ChatTaskStatus,
} from "./taskList";

const MAX_REMEMBERED_SCOPES = 64;
const taskTrayOpenByScope = new Map<string, boolean>();
const bgTrayOpenByScope = new Map<string, boolean>();

function useScopedDisclosure(store: Map<string, boolean>, scopeKey: string): [boolean, () => void] {
  const [open, setOpen] = useState(() => store.get(scopeKey) ?? false);

  useEffect(() => {
    setOpen(store.get(scopeKey) ?? false);
  }, [store, scopeKey]);

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      store.delete(scopeKey);
      store.set(scopeKey, next);
      if (store.size > MAX_REMEMBERED_SCOPES) {
        const oldest = store.keys().next().value;
        if (oldest !== undefined) store.delete(oldest);
      }
      return next;
    });
  };

  return [open, toggle];
}

/** Isolated 1s clock so ticks never re-render the chat timeline or parent strip. */
export const LiveElapsedText = memo(function LiveElapsedText({
  startedAt,
  settledAt,
  counting,
}: {
  startedAt: number;
  settledAt?: number | null;
  counting: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [counting, startedAt]);

  const end = counting ? now : (settledAt ?? now);
  return <>{formatChatDuration(Math.max(0, (end - startedAt) / 1000))}</>;
});

export function BackgroundKindIcon({
  kind,
  className = "w-3.5 h-3.5",
}: {
  kind: BackgroundTaskKind;
  className?: string;
}) {
  switch (kind) {
    case "agent":
      return <Bot className={`${className} text-accent-soft shrink-0`} />;
    case "command":
      return <SquareTerminal className={`${className} text-amber-400 shrink-0`} />;
    case "workflow":
      return <Workflow className={`${className} text-sky-400 shrink-0`} />;
    case "monitor":
      return <Activity className={`${className} text-emerald-400 shrink-0`} />;
    case "unknown":
      return <CircleHelp className={`${className} text-muted shrink-0`} />;
  }
}

export function TaskChecklistRows({ tasks }: { tasks: readonly ChatTaskItem[] }) {
  return (
    <div className="space-y-1">
      {tasks.map((task, idx) => (
        <div
          key={`${task.id ?? idx}-${task.content}`}
          className="flex items-start gap-2 py-0.5 text-xs min-w-0"
        >
          <span className="mt-0.5 shrink-0">{renderTaskStatusIcon(task.status)}</span>
          <span
            className={`min-w-0 flex-1 break-words leading-snug ${
              task.status === "completed" || task.status === "skipped"
                ? "text-muted line-through decoration-white/20"
                : task.status === "in_progress"
                  ? "text-fg font-medium"
                  : task.status === "failed"
                    ? "text-rose-300"
                    : "text-fg-soft"
            }`}
          >
            {taskDisplayLabel(task)}
          </span>
        </div>
      ))}
    </div>
  );
}

function renderTaskStatusIcon(status: ChatTaskStatus) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />;
    case "in_progress":
      return <Clock className="w-3.5 h-3.5 text-accent-soft animate-spin" />;
    case "failed":
      return <XCircle className="w-3.5 h-3.5 text-rose-400" />;
    case "skipped":
      return <MinusCircle className="w-3.5 h-3.5 text-dim" />;
    default:
      return <Circle className="w-3.5 h-3.5 text-dim" />;
  }
}

function renderWorkStateDot(state: SubagentState) {
  switch (state) {
    case "working":
      return (
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-soft opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
        </span>
      );
    case "completed":
      return <span className="inline-flex rounded-full h-2 w-2 bg-emerald-400/80 shrink-0" />;
    case "failed":
      return <span className="inline-flex rounded-full h-2 w-2 bg-rose-400 shrink-0" />;
    default:
      return <span className="inline-flex rounded-full h-2 w-2 bg-white/30 shrink-0" />;
  }
}

const DockedTaskListStrip = memo(function DockedTaskListStrip({
  list,
  scopeKey,
}: {
  list: ChatTaskList;
  scopeKey: string;
}) {
  const [open, toggleOpen] = useScopedDisclosure(taskTrayOpenByScope, `${scopeKey}:tasks`);
  const completed = completedTaskCount(list);
  const total = list.tasks.length;
  const activeTask = list.tasks.find((t) => t.status === "in_progress");
  const allDone = completed === total && total > 0;
  const lead = !open && activeTask ? taskDisplayLabel(activeTask) : "Tasks";

  return (
    <div
      data-testid="docked-task-list"
      className="rounded-xl border border-white/[0.08] bg-surface/95 overflow-hidden shadow-sm"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${lead}, ${completed} of ${total} tasks completed`}
        onClick={toggleOpen}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-white/[0.03] active:bg-white/[0.05] transition-colors min-w-0"
      >
        <ListChecks
          className={`w-3.5 h-3.5 shrink-0 ${
            allDone ? "text-emerald-400" : activeTask ? "text-accent-soft" : "text-muted"
          }`}
        />
        <span className="flex-1 min-w-0 truncate text-xs font-medium text-fg-soft">{lead}</span>
        <span
          className={`text-[11px] font-mono tabular-nums shrink-0 px-1.5 py-0.2 rounded ${
            allDone ? "bg-emerald-500/10 text-emerald-400" : "bg-white/[0.05] text-muted"
          }`}
        >
          {completed}/{total}
        </span>
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-muted shrink-0" />
        ) : (
          <ChevronUp className="w-3.5 h-3.5 text-muted shrink-0" />
        )}
      </button>

      {open && (
        <div className="px-3 pb-2.5 pt-1 border-t border-white/[0.06] max-h-40 overflow-y-auto scrollbar-sleek">
          <TaskChecklistRows tasks={list.tasks} />
          {list.explanation && (
            <p className="mt-1.5 text-[11px] text-muted leading-snug">{list.explanation}</p>
          )}
        </div>
      )}
    </div>
  );
});

const BackgroundWorkStrip = memo(function BackgroundWorkStrip({
  work,
  scopeKey,
}: {
  work: ActiveBackgroundWork;
  scopeKey: string;
}) {
  const [open, toggleOpen] = useScopedDisclosure(bgTrayOpenByScope, `${scopeKey}:bg`);

  return (
    <div
      data-testid="background-tasks-strip"
      className="rounded-xl border border-accent/25 bg-surface/95 overflow-hidden shadow-sm"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={toggleOpen}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-white/[0.03] active:bg-white/[0.05] transition-colors min-w-0"
      >
        {work.hasLiveWork && (
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-soft opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
          </span>
        )}
        <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-hidden text-xs">
          {work.segments.map((seg, idx) => (
            <Fragment key={`${seg.kind ?? "total"}-${idx}`}>
              {idx > 0 && <span className="text-dim shrink-0">·</span>}
              {seg.kind && <BackgroundKindIcon kind={seg.kind} className="w-3.5 h-3.5" />}
              <span className="font-medium text-fg-soft truncate">{seg.text}</span>
            </Fragment>
          ))}
          {(work.detail || work.clockStartedAt !== null) && (
            <span className="text-[11px] text-muted truncate shrink-0 ml-0.5">
              — {work.detail ?? ""}
              {work.clockStartedAt !== null && (
                <>
                  {work.detail ? " · " : ""}
                  <LiveElapsedText
                    startedAt={work.clockStartedAt}
                    settledAt={work.settledAt}
                    counting={work.hasLiveWork}
                  />
                </>
              )}
            </span>
          )}
        </div>
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-muted shrink-0" />
        ) : (
          <ChevronUp className="w-3.5 h-3.5 text-muted shrink-0" />
        )}
      </button>

      {open && (
        <div className="px-3 pb-2.5 pt-1.5 border-t border-white/[0.06] max-h-44 overflow-y-auto scrollbar-sleek space-y-2">
          {work.groups.map((group) => (
            <div key={group.kind} className="space-y-1">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-dim">
                {group.label}
              </div>
              {group.items.map((item) => {
                const isRunning = item.state === "working";
                return (
                  <div
                    key={`${group.kind}-${item.id}`}
                    className="flex items-center justify-between gap-2 py-1 px-2 rounded-lg bg-bg/70 border border-white/[0.05] text-xs min-w-0"
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <BackgroundKindIcon kind={item.kind} className="w-3.5 h-3.5" />
                      {renderWorkStateDot(item.state)}
                      <span
                        className={`truncate ${isRunning ? "text-fg font-medium" : "text-fg-soft"}`}
                      >
                        {item.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0 text-[10px] text-muted font-mono">
                      {typeof item.tokens === "number" && item.tokens > 0 && (
                        <span>{formatWorkTokens(item.tokens)}</span>
                      )}
                      {typeof item.startedAt === "number" && item.startedAt > 0 && (
                        <span>
                          <LiveElapsedText
                            startedAt={item.startedAt}
                            settledAt={item.settledAt}
                            counting={isRunning}
                          />
                        </span>
                      )}
                      <span
                        className={`px-1.5 py-0.5 rounded font-sans font-medium ${
                          item.state === "completed"
                            ? "bg-emerald-500/10 text-emerald-400"
                            : item.state === "failed"
                              ? "bg-rose-500/10 text-rose-400"
                              : item.state === "working"
                                ? "bg-accent/20 text-accent-soft"
                                : "bg-white/[0.06] text-muted"
                        }`}
                      >
                        {item.state === "unverifiable" ? "no update" : item.state}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

export const MobileNativeChatComposerTray = memo(function MobileNativeChatComposerTray({
  taskList,
  backgroundWork,
  scopeKey,
}: {
  taskList: ChatTaskList | null;
  backgroundWork: ActiveBackgroundWork | null;
  scopeKey: string;
}) {
  if (!taskList && !backgroundWork) return null;

  return (
    <div className="space-y-1.5">
      {taskList && <DockedTaskListStrip list={taskList} scopeKey={scopeKey} />}
      {backgroundWork && <BackgroundWorkStrip work={backgroundWork} scopeKey={scopeKey} />}
    </div>
  );
});
