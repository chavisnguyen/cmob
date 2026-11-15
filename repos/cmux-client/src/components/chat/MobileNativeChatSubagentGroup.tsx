import { useState } from "react";
import {
  Bot,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  XCircle,
  Clock,
  AlertCircle,
} from "lucide-react";
import type { SubagentEntry, SubagentState } from "../../protocol/event";

interface MobileNativeChatSubagentGroupProps {
  groupId: string;
  agents: SubagentEntry[];
}

export function MobileNativeChatSubagentGroup({
  groupId: _groupId,
  agents,
}: MobileNativeChatSubagentGroupProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (agents.length === 0) return null;

  // Derive group status
  const isWorking = agents.some((a) => a.state === "working");
  const hasFailed = agents.some((a) => a.state === "failed");
  const totalTokens = agents.reduce((acc, a) => acc + (a.tokens || 0), 0);

  const allCompleted = agents.every((a) => a.state === "completed");
  let groupStateText = "completed";
  if (isWorking) groupStateText = "working";
  else if (hasFailed) groupStateText = "failed";
  // Orca keeps silent children as "unverifiable" instead of claiming they finished
  // (ref/orca/src/shared/agent-status/presentation/agent-row-decay-state.ts).
  else if (!allCompleted) groupStateText = "no update";

  const headline = isWorking
    ? `Kicked off ${agents.length} subagent${agents.length > 1 ? "s" : ""}`
    : `Ran ${agents.length} subagent${agents.length > 1 ? "s" : ""}`;

  return (
    <div className="w-full rounded-xl border border-purple-500/30 bg-[#1b1728] text-xs font-mono overflow-hidden my-1.5 shadow-sm">
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className="w-full flex items-center justify-between px-3 py-2 bg-purple-950/40 hover:bg-purple-900/30 text-purple-200 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
          <Bot className={`w-4 h-4 text-purple-400 ${isWorking ? "animate-pulse" : ""}`} />
          <span className="font-semibold text-purple-200 truncate">{headline}</span>
          {isWorking && (
            <span className="flex h-1.5 w-1.5 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-purple-500" />
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {totalTokens > 0 && (
            <span className="text-[10px] text-purple-400/80 bg-purple-900/40 px-1.5 py-0.5 rounded">
              {formatTokens(totalTokens)}
            </span>
          )}
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
              groupStateText === "completed"
                ? "bg-emerald-500/10 text-emerald-400"
                : groupStateText === "failed"
                  ? "bg-rose-500/10 text-rose-400"
                  : groupStateText === "no update"
                    ? "bg-gray-800 text-gray-400"
                    : "bg-purple-500/20 text-purple-300"
            }`}
          >
            {groupStateText}
          </span>
          {isExpanded ? (
            <ChevronUp className="w-3.5 h-3.5 text-purple-300" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-purple-300" />
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="p-2 space-y-1.5 border-t border-purple-500/20 bg-[#14121f]">
          {agents.map((agent) => (
            <div
              key={agent.id}
              className="flex items-center justify-between p-2 rounded-lg bg-[#1e1a2d] border border-purple-500/20"
            >
              <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
                {getSubagentStateIcon(agent.state)}
                <span className="font-medium text-gray-200 truncate">
                  {agent.label || agent.id}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0 text-[10px]">
                {agent.tokens && (
                  <span className="text-gray-400 font-mono">{formatTokens(agent.tokens)}</span>
                )}
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
}

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
      return <Clock className="w-3.5 h-3.5 text-purple-400 animate-spin shrink-0" />;
    default:
      return <AlertCircle className="w-3.5 h-3.5 text-gray-400 shrink-0" />;
  }
}

function getSubagentStateBadge(state: SubagentState): string {
  switch (state) {
    case "completed":
      return "bg-emerald-500/10 text-emerald-400";
    case "failed":
      return "bg-rose-500/10 text-rose-400";
    case "working":
      return "bg-purple-500/20 text-purple-300";
    default:
      return "bg-gray-800 text-gray-400";
  }
}
