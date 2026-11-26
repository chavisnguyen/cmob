import { memo } from "react";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  StopCircle,
  XCircle,
} from "lucide-react";
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
  let groupStateText = "completed";
  if (isWorking) {
    groupStateText =
      agents.length > 1 && workingCount < agents.length
        ? `${workingCount}/${agents.length} working`
        : "working";
  } else if (hasFailed) {
    groupStateText = "failed";
  } else if (allStopped) {
    groupStateText = "stopped";
  } else if (!allCompleted) {
    groupStateText = "no update";
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
    ? `Kicked off ${agents.length} subagent${agents.length > 1 ? "s" : ""}`
    : `Ran ${agents.length} subagent${agents.length > 1 ? "s" : ""}`;

  return (
    <div className="w-full rounded-xl border border-accent/30 bg-surface text-xs font-mono overflow-hidden my-1.5 shadow-sm">
      <button
        type="button"
        aria-expanded={isExpanded}
        onClick={toggleExpanded}
        className="w-full flex items-center justify-between px-3 py-2 bg-accent/10 hover:bg-accent/15 text-accent-soft transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
          <Bot
            className={`w-4 h-4 text-accent-soft shrink-0 ${isWorking ? "animate-pulse" : ""}`}
          />
          <span className="font-semibold text-accent-soft truncate">{headline}</span>
          {isWorking && (
            <span className="flex h-1.5 w-1.5 relative shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-soft opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-accent" />
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {clockStartedAt !== null && (
            <span className="text-[10px] text-accent-soft/80 tabular-nums">
              <LiveElapsedText
                startedAt={clockStartedAt}
                settledAt={settledAt}
                counting={isWorking}
              />
            </span>
          )}
          {totalTokens > 0 && (
            <span className="text-[10px] text-accent-soft/80 bg-accent/10 px-1.5 py-0.5 rounded">
              {formatTokens(totalTokens)}
            </span>
          )}
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
              groupStateText === "completed"
                ? "bg-emerald-500/10 text-emerald-400"
                : groupStateText === "failed"
                  ? "bg-rose-500/10 text-rose-400"
                  : groupStateText === "no update" || groupStateText === "stopped"
                    ? "bg-gray-800 text-muted"
                    : "bg-accent/20 text-accent-soft"
            }`}
          >
            {groupStateText}
          </span>
          {isExpanded ? (
            <ChevronUp className="w-3.5 h-3.5 text-accent-soft" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-accent-soft" />
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="p-2 space-y-1.5 border-t border-accent/20 bg-bg">
          {agents.map((agent) => (
            <div
              key={agent.id}
              className="flex items-center justify-between p-2 rounded-lg bg-surface border border-accent/20"
            >
              <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
                {getSubagentStateIcon(agent.state)}
                <span className="font-medium text-fg-soft truncate">{agent.label || agent.id}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0 text-[10px]">
                {typeof agent.started_at === "number" && agent.started_at > 0 && (
                  <span className="text-muted font-mono tabular-nums">
                    <LiveElapsedText
                      startedAt={agent.started_at}
                      settledAt={agent.settled_at}
                      counting={agent.state === "working"}
                    />
                  </span>
                )}
                {agent.tokens ? (
                  <span className="text-muted font-mono">{formatTokens(agent.tokens)}</span>
                ) : null}
                <span className={`px-1.5 py-0.5 rounded ${getSubagentStateBadge(agent.state)}`}>
                  {agent.state === "unverifiable" ? "no update" : agent.state}
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
  if (tokens < 1000) return `${tokens} tokens`;
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}k tokens`;
  return `${(tokens / 1000000).toFixed(1)}M tokens`;
}

function getSubagentStateIcon(state: SubagentState) {
  switch (state) {
    case "completed":
      return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
    case "failed":
      return <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />;
    case "working":
      return <Clock className="w-3.5 h-3.5 text-accent-soft animate-spin shrink-0" />;
    case "stopped":
      return <StopCircle className="w-3.5 h-3.5 text-muted shrink-0" />;
    default:
      return <AlertCircle className="w-3.5 h-3.5 text-muted shrink-0" />;
  }
}

function getSubagentStateBadge(state: SubagentState): string {
  switch (state) {
    case "completed":
      return "bg-emerald-500/10 text-emerald-400";
    case "failed":
      return "bg-rose-500/10 text-rose-400";
    case "working":
      return "bg-accent/20 text-accent-soft";
    default:
      return "bg-gray-800 text-muted";
  }
}
