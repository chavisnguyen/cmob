import { Fragment, memo } from "react";
import { ChevronDown, ChevronUp, ListChecks } from "lucide-react";
import {
  completedTaskCount,
  formatWorkTokens,
  taskDisplayLabel,
  type ActiveBackgroundWork,
  type ChatTaskList,
} from "../../domain/chat/taskList";
import type { SubagentState } from "../../protocol/event";
import { useChatDisclosure } from "../../state/useChatDisclosure";
import { BackgroundKindIcon, LiveElapsedText, TaskChecklistRows } from "./ChatWorkPrimitives";

export { BackgroundKindIcon, LiveElapsedText, TaskChecklistRows } from "./ChatWorkPrimitives";

function renderWorkStateDot(state: SubagentState) {
  switch (state) {
    case "working":
      return (
        <span className="inline-flex rounded-full h-1.5 w-1.5 bg-status-run animate-pulse shrink-0" />
      );
    case "completed":
      return <span className="inline-flex rounded-full h-1.5 w-1.5 bg-status-ok shrink-0" />;
    case "failed":
      return <span className="inline-flex rounded-full h-1.5 w-1.5 bg-status-err shrink-0" />;
    default:
      return <span className="inline-flex rounded-full h-1.5 w-1.5 bg-dim shrink-0" />;
  }
}

const DockedTaskListStrip = memo(function DockedTaskListStrip({
  list,
  scopeKey,
  isWorking,
}: {
  list: ChatTaskList;
  scopeKey: string;
  isWorking: boolean;
}) {
  const [open, toggleOpen] = useChatDisclosure(scopeKey, "tray:tasks", false);
  const completed = completedTaskCount(list);
  const total = list.tasks.length;
  const activeTask = list.tasks.find((t) => t.status === "in_progress");
  const lead = !open && activeTask ? taskDisplayLabel(activeTask) : "Tasks";

  return (
    <div
      data-testid="docked-task-list"
      className="rounded-lg border border-line bg-sidebar overflow-hidden"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${lead}, ${completed} of ${total} tasks completed`}
        onClick={toggleOpen}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-surface transition-colors min-w-0"
      >
        <ListChecks className="w-3.5 h-3.5 shrink-0 text-accent/85" />
        <span className="flex-1 min-w-0 truncate text-[12px] font-medium text-fg-soft">{lead}</span>
        <span className="text-[11px] font-mono tabular-nums shrink-0 text-muted">
          {completed}/{total}
        </span>
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-dim shrink-0" />
        ) : (
          <ChevronUp className="w-3.5 h-3.5 text-dim shrink-0" />
        )}
      </button>

      {open && (
        <div className="px-3 pb-2.5 pt-1.5 border-t border-line max-h-40 overflow-y-auto scrollbar-sleek">
          <TaskChecklistRows tasks={list.tasks} isSessionWorking={isWorking} />
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
      className="rounded-lg border border-line bg-sidebar overflow-hidden"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={toggleOpen}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-surface transition-colors min-w-0"
      >
        {work.hasLiveWork && (
          <span className="inline-flex rounded-full h-1.5 w-1.5 bg-status-run animate-pulse shrink-0" />
        )}
        <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-hidden text-[12px]">
          {work.segments.map((seg, idx) => (
            <Fragment key={`${seg.kind ?? "total"}-${idx}`}>
              {idx > 0 && <span className="text-dim shrink-0">·</span>}
              {seg.kind && <BackgroundKindIcon kind={seg.kind} className="w-3.5 h-3.5" />}
              <span className="font-medium text-fg-soft truncate">{seg.text}</span>
            </Fragment>
          ))}
          {(work.detail || work.clockStartedAt !== null) && (
            <span className="text-[11px] text-muted truncate shrink-0 ml-0.5 font-mono">
              · {work.detail ?? ""}
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
          <ChevronDown className="w-3.5 h-3.5 text-dim shrink-0" />
        ) : (
          <ChevronUp className="w-3.5 h-3.5 text-dim shrink-0" />
        )}
      </button>

      {open && (
        <div className="px-3 pb-2.5 pt-1.5 border-t border-line max-h-44 overflow-y-auto scrollbar-sleek space-y-2">
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
                    className="flex items-center justify-between gap-2 py-1 px-2 rounded-[5px] bg-bg/70 border border-line/60 text-[11.5px] min-w-0"
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <BackgroundKindIcon kind={item.kind} className="w-3 h-3" />
                      {renderWorkStateDot(item.state)}
                      <span
                        className={`truncate ${isRunning ? "text-fg font-medium" : "text-fg-soft"}`}
                      >
                        {item.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 text-[10.5px] text-dim font-mono">
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
                      <span className={item.state === "failed" ? "text-status-err" : "text-muted"}>
                        {item.state === "unverifiable" ? "ended" : item.state}
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
  isWorking = false,
}: {
  taskList: ChatTaskList | null;
  backgroundWork: ActiveBackgroundWork | null;
  scopeKey: string;
  isWorking?: boolean;
}) {
  if (!taskList && !backgroundWork) return null;

  return (
    <div className="space-y-1">
      {taskList && (
        <DockedTaskListStrip list={taskList} scopeKey={scopeKey} isWorking={isWorking} />
      )}
      {backgroundWork && <BackgroundWorkStrip work={backgroundWork} scopeKey={scopeKey} />}
    </div>
  );
});
