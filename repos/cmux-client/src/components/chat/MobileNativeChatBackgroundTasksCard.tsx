/**
 * Inline Background Task Card inside the conversation timeline.
 * Mirrors Orca's `nativeChatBackgroundTaskRun` (`ref/orca/src/shared/native-chat/transcript/native-chat-background-task-run.ts`).
 */

import { memo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { BackgroundTaskEntry } from "../../protocol/event";
import { BackgroundKindIcon, LiveElapsedText } from "./MobileNativeChatComposerTray";
import { formatWorkTokens } from "./taskList";

export const MobileNativeChatBackgroundTasksCard = memo(
  function MobileNativeChatBackgroundTasksCard({ tasks }: { tasks: BackgroundTaskEntry[] }) {
    const [expanded, setExpanded] = useState(false);

    if (tasks.length === 0) return null;

    const isWorking = tasks.some((t) => t.state === "working");
    const hasFailed = tasks.some((t) => t.state === "failed");
    const first = tasks[0];
    const headline =
      tasks.length === 1
        ? first.label
        : `${isWorking ? "Running" : "Ran"} ${tasks.length} background tasks`;

    const badgeText = isWorking
      ? "running"
      : hasFailed
        ? "failed"
        : tasks.every((t) => t.state === "stopped")
          ? "stopped"
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
        className="w-full rounded-xl border border-white/[0.08] bg-surface text-xs font-mono overflow-hidden my-1 shadow-sm"
      >
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="w-full flex items-center justify-between px-3 py-2 hover:bg-white/[0.03] text-fg-soft transition-colors"
        >
          <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
            <BackgroundKindIcon kind={first.kind} className="w-3.5 h-3.5" />
            <span className="font-medium text-fg-soft truncate font-sans">{headline}</span>
            {isWorking && (
              <span className="flex h-1.5 w-1.5 relative shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-500" />
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {startedAt !== null && (
              <span className="text-[10px] text-muted tabular-nums">
                <LiveElapsedText startedAt={startedAt} settledAt={settledAt} counting={isWorking} />
              </span>
            )}
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded font-sans font-medium ${
                badgeText === "done"
                  ? "bg-emerald-500/10 text-emerald-400"
                  : badgeText === "failed"
                    ? "bg-rose-500/10 text-rose-400"
                    : badgeText === "running"
                      ? "bg-amber-500/15 text-amber-300"
                      : "bg-white/[0.06] text-muted"
              }`}
            >
              {badgeText}
            </span>
            {expanded ? (
              <ChevronUp className="w-3.5 h-3.5 text-muted" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-muted" />
            )}
          </div>
        </button>

        {expanded && (
          <div className="p-2 space-y-1.5 border-t border-white/[0.06] bg-bg/70">
            {tasks.map((task) => (
              <div
                key={task.id}
                className="p-2 rounded-lg bg-surface border border-white/[0.06] space-y-1"
              >
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <BackgroundKindIcon kind={task.kind} className="w-3.5 h-3.5" />
                    <span className="font-sans font-medium text-fg-soft truncate">
                      {task.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 text-[10px] text-muted">
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
