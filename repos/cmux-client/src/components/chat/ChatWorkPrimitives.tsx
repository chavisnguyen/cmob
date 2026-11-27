import { memo, useEffect, useState } from "react";
import {
  Activity,
  CheckCircle2,
  Circle,
  CircleHelp,
  Clock,
  Cpu,
  MinusCircle,
  SquareTerminal,
  Workflow,
  XCircle,
} from "lucide-react";
import {
  formatChatDuration,
  taskDisplayLabel,
  type ChatTaskItem,
  type ChatTaskStatus,
} from "../../domain/chat/taskList";
import type { BackgroundTaskKind } from "../../protocol/event";

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

  // Never synthesize a fake duration from `Date.now()` for a settled/unverifiable item lacking `settledAt`.
  if (!counting && (typeof settledAt !== "number" || settledAt < startedAt)) {
    return null;
  }
  const end = counting ? now : settledAt!;
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
      return <Cpu className={`${className} text-accent-soft shrink-0`} />;
    case "command":
      return <SquareTerminal className={`${className} text-status-ok shrink-0`} />;
    case "workflow":
      return <Workflow className={`${className} text-[#82a8c9] shrink-0`} />;
    case "monitor":
      return <Activity className={`${className} text-status-wait shrink-0`} />;
    case "unknown":
      return <CircleHelp className={`${className} text-dim shrink-0`} />;
  }
}

function renderTaskStatusIcon(status: ChatTaskStatus, isSessionWorking: boolean) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="w-3.5 h-3.5 text-status-ok" />;
    case "in_progress":
      return (
        <Clock className={`w-3.5 h-3.5 text-accent ${isSessionWorking ? "animate-spin" : ""}`} />
      );
    case "failed":
      return <XCircle className="w-3.5 h-3.5 text-status-err" />;
    case "skipped":
      return <MinusCircle className="w-3.5 h-3.5 text-dim" />;
    default:
      return <Circle className="w-3.5 h-3.5 text-dim" />;
  }
}

export function TaskChecklistRows({
  tasks,
  isSessionWorking = false,
}: {
  tasks: readonly ChatTaskItem[];
  isSessionWorking?: boolean;
}) {
  return (
    <div className="space-y-1">
      {tasks.map((task, idx) => (
        <div
          key={`${task.id ?? idx}-${task.content}`}
          className="flex items-start gap-2 py-0.5 text-[12px] min-w-0"
        >
          <span className="mt-0.5 shrink-0">
            {renderTaskStatusIcon(task.status, isSessionWorking)}
          </span>
          <span
            className={`min-w-0 flex-1 break-words leading-snug ${
              task.status === "completed" || task.status === "skipped"
                ? "text-muted line-through decoration-line-strong"
                : task.status === "in_progress"
                  ? "text-fg font-medium"
                  : task.status === "failed"
                    ? "text-status-err"
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
