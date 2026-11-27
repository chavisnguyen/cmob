import { memo } from "react";
import { ChevronDown, ChevronUp, Cpu } from "lucide-react";
import type { SubagentEntry, SubagentState } from "../../protocol/event";
import { useChatDisclosure } from "../../state/useChatDisclosure";
import { LiveElapsedText } from "./ChatWorkPrimitives";

interface MobileNativeChatSubagentGroupProps {
  groupId: string;
  agents: SubagentEntry[];
  surfaceKey?: string;
}

export const MobileNativeChatSubagentGroup = memo(function MobileNativeChatSubagentGroup({
  groupId,
  agents,
  surfaceKey,
}: MobileNativeChatSubagentGroupProps) {
  const [isExpanded, toggleExpanded] = useChatDisclosure(surfaceKey, `subagents:${groupId}`, false);

  if (agents.length === 0) return null;

  const workingCount = agents.filter((a) => a.state === "working").length;
  const isWorking = workingCount > 0;
  const hasFailed = agents.some((a) => a.state === "failed");
  const allStopped = agents.every((a) => a.state === "stopped");
  const totalTokens = agents.reduce((acc, a) => acc + (a.tokens || 0), 0);

  const allCompleted = agents.every((a) => a.state === "completed");
  const completedCount = agents.filter((a) => a.state === "completed").length;
  const hasUnverifiable = agents.some((a) => a.state === "unverifiable");
  let groupStateText = "done";
  if (isWorking) {
    groupStateText =
      agents.length > 1 && workingCount < agents.length
        ? `${workingCount}/${agents.length} running`
        : "running";
  } else if (hasFailed) {
    groupStateText = "failed";
  } else if (allStopped) {
    groupStateText = "stopped";
  } else if (!allCompleted) {
    groupStateText =
      hasUnverifiable && completedCount > 0
        ? `${completedCount}/${agents.length} done`
        : hasUnverifiable
          ? "ended"
          : "idle";
  }

  const startedCandidates = agents
    .map((a) => a.started_at)
    .filter((n): n is number => typeof n === "number" && n > 0);
  const clockStartedAt = startedCandidates.length > 0 ? Math.min(...startedCandidates) : null;
  const settledCandidates = agents
    .map((a) => a.settled_at)
    .filter((n): n is number => typeof n === "number" && n > 0);
  const settledAt =
    !isWorking && settledCandidates.length > 0 ? Math.max(...settledCandidates) : null;

  const headline = isWorking
    ? `Running ${agents.length} subagent${agents.length > 1 ? "s" : ""}`
    : `Ran ${agents.length} subagent${agents.length > 1 ? "s" : ""}`;

  return (
    <div className="w-full rounded-lg border border-line bg-sidebar text-[12px] overflow-hidden my-1">
      <button
        type="button"
        aria-expanded={isExpanded}
        onClick={toggleExpanded}
        className="w-full flex items-center justify-between px-2.5 py-1.5 hover:bg-surface text-fg-soft transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
          <Cpu className="w-3.5 h-3.5 text-accent-soft shrink-0" />
          <span className="font-medium text-fg-soft truncate">{headline}</span>
          {isWorking && (
            <span className="w-1.5 h-1.5 rounded-full bg-status-run animate-pulse shrink-0" />
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 text-[11px] font-mono text-dim">
          {clockStartedAt !== null && (
            <span className="tabular-nums">
              <LiveElapsedText
                startedAt={clockStartedAt}
                settledAt={settledAt}
                counting={isWorking}
              />
            </span>
          )}
          {totalTokens > 0 && <span>{formatTokens(totalTokens)}</span>}
          <span
            className={stateTextClass(hasFailed ? "failed" : isWorking ? "working" : "completed")}
          >
            {groupStateText}
          </span>
          {isExpanded ? (
            <ChevronUp className="w-3 h-3 text-dim" />
          ) : (
            <ChevronDown className="w-3 h-3 text-dim" />
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="px-2.5 py-1.5 space-y-1 border-t border-line bg-bg/60">
          {agents.map((agent) => (
            <div
              key={agent.id}
              className="flex items-center justify-between py-1 px-2 rounded-[5px] bg-sidebar/80 text-[11.5px]"
            >
              <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${stateDotClass(agent.state)}`}
                />
                <span className="text-fg-soft truncate">{agent.label || agent.id}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0 text-[10.5px] font-mono text-dim">
                {typeof agent.started_at === "number" && agent.started_at > 0 && (
                  <span className="tabular-nums">
                    <LiveElapsedText
                      startedAt={agent.started_at}
                      settledAt={agent.settled_at}
                      counting={agent.state === "working"}
                    />
                  </span>
                )}
                {agent.tokens ? <span>{formatTokens(agent.tokens)}</span> : null}
                <span className={stateTextClass(agent.state)}>
                  {agent.state === "unverifiable" ? "ended" : agent.state}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens} tok`;
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}k tok`;
  return `${(tokens / 1000000).toFixed(1)}M tok`;
}

function stateDotClass(state: SubagentState): string {
  switch (state) {
    case "completed":
      return "bg-status-ok";
    case "failed":
      return "bg-status-err";
    case "working":
      return "bg-status-run animate-pulse";
    default:
      return "bg-dim";
  }
}

function stateTextClass(state: SubagentState): string {
  switch (state) {
    case "failed":
      return "text-status-err";
    case "working":
      return "text-accent-soft";
    case "completed":
      return "text-status-ok/90";
    default:
      return "text-muted";
  }
}
