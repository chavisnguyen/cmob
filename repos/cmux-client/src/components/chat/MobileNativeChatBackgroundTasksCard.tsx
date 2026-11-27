import { memo } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { formatWorkTokens } from "../../domain/chat/taskList";
import type { BackgroundTaskEntry } from "../../protocol/event";
import { useChatDisclosure } from "../../state/useChatDisclosure";
import { BackgroundKindIcon, LiveElapsedText } from "./ChatWorkPrimitives";

export const MobileNativeChatBackgroundTasksCard = memo(
  function MobileNativeChatBackgroundTasksCard({
    tasks,
    surfaceKey,
    itemKey,
  }: {
    tasks: BackgroundTaskEntry[];
    surfaceKey?: string;
    itemKey?: string;
  }) {
    const resolvedKey = `bgtasks:${itemKey ?? tasks[0]?.id ?? "bg"}`;
    const [expanded, toggleExpanded] = useChatDisclosure(surfaceKey, resolvedKey, false);

    if (tasks.length === 0) return null;

    const isWorking = tasks.some((t) => t.state === "working");
    const hasFailed = tasks.some((t) => t.state === "failed");
    const allStopped = tasks.every((t) => t.state === "stopped");
    const allCompleted = tasks.every((t) => t.state === "completed");
    const hasUnverifiable = tasks.some((t) => t.state === "unverifiable");
    const first = tasks[0];
    const headline =
      tasks.length === 1
        ? first.label
        : `${isWorking ? "Running" : "Ran"} ${tasks.length} background tasks`;

    const badgeText = isWorking
      ? "running"
      : hasFailed
        ? "failed"
        : allStopped
          ? "stopped"
          : allCompleted
            ? "done"
            : hasUnverifiable
              ? "ended"
              : "done";

    const startedCandidates = tasks
      .map((t) => t.started_at)
      .filter((n): n is number => typeof n === "number" && n > 0);
    const startedAt = startedCandidates.length > 0 ? Math.min(...startedCandidates) : null;
    const settledCandidates = tasks
      .map((t) => t.settled_at)
      .filter((n): n is number => typeof n === "number" && n > 0);
    const settledAt =
      !isWorking && settledCandidates.length > 0 ? Math.max(...settledCandidates) : null;

    return (
      <div
        data-testid="background-task-card"
        className="w-full rounded-lg border border-line bg-sidebar text-[12px] overflow-hidden my-1"
      >
        <button
          type="button"
          aria-expanded={expanded}
          onClick={toggleExpanded}
          className="w-full flex items-center justify-between px-2.5 py-1.5 hover:bg-surface text-fg-soft transition-colors"
        >
          <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
            <BackgroundKindIcon kind={first.kind} className="w-3.5 h-3.5" />
            <span className="font-medium text-fg-soft truncate font-sans">{headline}</span>
            {isWorking && (
              <span className="w-1.5 h-1.5 rounded-full bg-status-run animate-pulse shrink-0" />
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0 text-[11px] font-mono text-dim">
            {startedAt !== null && (
              <span className="tabular-nums">
                <LiveElapsedText startedAt={startedAt} settledAt={settledAt} counting={isWorking} />
              </span>
            )}
            <span
              className={
                badgeText === "failed"
                  ? "text-status-err"
                  : badgeText === "running"
                    ? "text-accent-soft"
                    : badgeText === "done"
                      ? "text-status-ok/90"
                      : "text-muted"
              }
            >
              {badgeText}
            </span>
            {expanded ? (
              <ChevronUp className="w-3 h-3 text-dim" />
            ) : (
              <ChevronDown className="w-3 h-3 text-dim" />
            )}
          </div>
        </button>

        {expanded && (
          <div className="p-2 space-y-1.5 border-t border-line bg-bg/60">
            {tasks.map((task) => (
              <div
                key={task.id}
                className="p-2 rounded-[5px] bg-sidebar/80 border border-line/60 space-y-1"
              >
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <BackgroundKindIcon kind={task.kind} className="w-3 h-3 text-dim" />
                    <span className="font-sans font-medium text-fg-soft truncate">
                      {task.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 text-[10.5px] font-mono text-dim">
                    {typeof task.tokens === "number" && task.tokens > 0 && (
                      <span>{formatWorkTokens(task.tokens)}</span>
                    )}
                    {typeof task.started_at === "number" && task.started_at > 0 && (
                      <span>
                        <LiveElapsedText
                          startedAt={task.started_at}
                          settledAt={task.settled_at}
                          counting={task.state === "working"}
                        />
                      </span>
                    )}
                  </div>
                </div>
                {task.summary && (
                  <p className="text-[11px] font-sans text-muted whitespace-pre-wrap break-words leading-snug">
                    {task.summary}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  },
);
