import { memo, useEffect, useState } from "react";
import {
  Activity,
  Bot,
  CheckCircle2,
  Circle,
  CircleHelp,
  Clock,
  MinusCircle,
  SquareTerminal,
  Workflow,
  XCircle,
} from "lucide-react";
import type { BackgroundTaskKind } from "../../protocol/event";
import {
  formatChatDuration,
  taskDisplayLabel,
  type ChatTaskItem,
  type ChatTaskStatus,
} from "./taskList";

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
