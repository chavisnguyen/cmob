import { Fragment, memo } from "react";
import { ChevronDown, ChevronUp, ListChecks } from "lucide-react";
import type { SubagentState } from "../../protocol/event";
import { useChatDisclosure } from "../../state/useChatDisclosure";
import { BackgroundKindIcon, LiveElapsedText, TaskChecklistRows } from "./ChatWorkPrimitives";
import {
  completedTaskCount,
  formatWorkTokens,
  taskDisplayLabel,
  type ActiveBackgroundWork,
  type ChatTaskList,
} from "./taskList";

export { BackgroundKindIcon, LiveElapsedText, TaskChecklistRows } from "./ChatWorkPrimitives";

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
  const [open, toggleOpen] = useChatDisclosure(scopeKey, "tray:tasks", false);
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
  const [open, toggleOpen] = useChatDisclosure(scopeKey, "tray:bg", false);

  return (
    <div
      data-testid="background-tasks-strip"
      className="rounded-xl border border-white/[0.08] bg-surface/95 overflow-hidden"
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
