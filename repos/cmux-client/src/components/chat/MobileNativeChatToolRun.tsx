import { memo } from "react";
import {
  Brain,
  ChevronDown,
  ChevronRight,
  Cpu,
  Eye,
  Folder,
  Globe,
  ListChecks,
  Pencil,
  Plug,
  Search,
  SquareTerminal,
  Wrench,
  XCircle,
} from "lucide-react";
import type { ThoughtStepItem, ToolCallItem, WorkRunStepItem } from "../../domain/chat/types";
import { useChatDisclosure } from "../../state/useChatDisclosure";
import { TaskChecklistRows } from "./ChatWorkPrimitives";
import { MobileNativeChatDiffCard } from "./MobileNativeChatDiffCard";
import { describeTaskToolCall, formatChatDuration } from "./taskList";
import {
  classifyToolCategory,
  deriveToolRunSentence,
  formatSingleToolMemberLabel,
  parseEditDetails,
  type ToolCategory,
} from "./toolRunSentence";

export type { ToolCallItem } from "../../domain/chat/types";

interface MobileNativeChatToolRunProps {
  tools: ToolCallItem[];
  steps?: WorkRunStepItem[];
  thoughts?: ThoughtStepItem[];
  totalThoughtSeconds?: number;
  live?: boolean;
  surfaceKey?: string;
  blockKey?: string;
}

export const MobileNativeChatToolRun = memo(function MobileNativeChatToolRun({
  tools,
  steps,
  thoughts,
  totalThoughtSeconds = 0,
  live = false,
  surfaceKey,
  blockKey,
}: MobileNativeChatToolRunProps) {
  const disclosureId = `workrun:${blockKey ?? tools[0]?.id ?? "run"}`;
  const [isExpanded, toggleExpanded] = useChatDisclosure(surfaceKey, disclosureId, false);

  if (tools.length === 0) return null;

  const toolSentence = deriveToolRunSentence(tools, live);
  const hasThoughts = Boolean(thoughts && thoughts.length > 0);
  const thoughtPrefix = hasThoughts
    ? totalThoughtSeconds > 0
      ? `Thought for ${formatChatDuration(totalThoughtSeconds)} · `
      : "Thought · "
    : "";
  const summary = `${thoughtPrefix}${toolSentence}`;
  const allSuccess = tools.every((t) => t.ok !== false);
  const primaryCategory = classifyToolCategory(tools[0].name);
  const effectiveSteps: WorkRunStepItem[] = steps ?? tools.map((tool) => ({ kind: "tool", tool }));

  return (
    <div className="w-full my-0.5 text-xs">
      <button
        type="button"
        aria-expanded={isExpanded}
        onClick={toggleExpanded}
        className="w-full flex items-center justify-between py-1 px-1 rounded-md hover:bg-white/[0.04] text-muted hover:text-fg-soft transition-colors min-w-0"
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1 mr-2">
          {isExpanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-muted shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-muted shrink-0" />
          )}
          {renderCategoryIcon(primaryCategory, !allSuccess)}
          <span className="font-medium text-fg-soft truncate font-sans">{summary}</span>
          {live && (
            <span className="flex h-1.5 w-1.5 relative shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-500" />
            </span>
          )}
        </div>
        {!live && !allSuccess && (
          <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.2 rounded bg-rose-500/10 text-rose-400 font-medium shrink-0">
            <XCircle className="w-3 h-3" />
            Failed
          </span>
        )}
      </button>

      {isExpanded && (
        <div className="ml-5 pl-3 my-1 border-l border-white/10 space-y-1.5">
          {effectiveSteps.map((step, idx) => {
            if (step.kind === "thinking") {
              return (
                <div
                  key={`thought-${step.thought.id}-${idx}`}
                  className="py-1 space-y-1 text-[11.5px] font-sans text-muted"
                >
                  <div className="flex items-center gap-1.5 text-dim font-medium">
                    <Brain className="w-3.5 h-3.5 shrink-0 text-muted" />
                    <span>
                      {step.thought.durationSeconds && step.thought.durationSeconds > 0
                        ? `Thought for ${formatChatDuration(step.thought.durationSeconds)}`
                        : "Thought"}
                    </span>
                  </div>
                  <p className="pl-5 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto scrollbar-thin">
                    {step.thought.text}
                  </p>
                </div>
              );
            }

            const t = step.tool;
            const cat = classifyToolCategory(t.name);
            const isEdit = cat === "fileChange";
            const editDetails = isEdit ? parseEditDetails(t.inputDetail ?? t.detail) : null;
            const taskInfo = describeTaskToolCall(t.name, t.inputDetail ?? t.detail);
            const itemLabel = taskInfo ? taskInfo.headline : formatSingleToolMemberLabel(t);

            return (
              <div key={`${t.id}-${idx}`} className="space-y-1 py-0.5">
                <div className="flex items-start gap-1.5 min-w-0">
                  <div className="mt-0.5 shrink-0">{renderCategoryIcon(cat, t.ok === false)}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-fg-soft text-[11.5px] font-mono truncate">
                        {itemLabel}
                      </span>
                      {t.isEnd && t.ok === false && (
                        <span className="text-[9px] px-1 rounded shrink-0 bg-rose-500/10 text-rose-400">
                          failed
                        </span>
                      )}
                    </div>
                    {taskInfo?.list && taskInfo.list.tasks.length > 0 ? (
                      <div className="mt-1 font-sans">
                        <TaskChecklistRows tasks={taskInfo.list.tasks} />
                      </div>
                    ) : (
                      !taskInfo &&
                      t.detail &&
                      !editDetails && (
                        <p className="mt-0.5 text-muted text-[10.5px] font-mono whitespace-pre-wrap break-all max-h-32 overflow-y-auto scrollbar-thin">
                          {t.detail}
                        </p>
                      )
                    )}
                  </div>
                </div>

                {editDetails && (
                  <MobileNativeChatDiffCard
                    path={editDetails.path}
                    diff={editDetails.diff}
                    added={editDetails.added}
                    removed={editDetails.removed}
                    surfaceKey={surfaceKey}
                    itemKey={`${disclosureId}:diff:${t.id}:${idx}`}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

function renderCategoryIcon(cat: ToolCategory, failed = false) {
  const errCls = failed ? "text-rose-400" : undefined;
  switch (cat) {
    case "read":
      return <Eye className={`w-3.5 h-3.5 shrink-0 ${errCls ?? "text-accent-soft"}`} />;
    case "search":
      return <Search className={`w-3.5 h-3.5 shrink-0 ${errCls ?? "text-accent-soft"}`} />;
    case "listFiles":
      return <Folder className={`w-3.5 h-3.5 shrink-0 ${errCls ?? "text-accent-soft"}`} />;
    case "fileChange":
      return <Pencil className={`w-3.5 h-3.5 shrink-0 ${errCls ?? "text-amber-300"}`} />;
    case "command":
      return <SquareTerminal className={`w-3.5 h-3.5 shrink-0 ${errCls ?? "text-amber-400"}`} />;
    case "webSearch":
      return <Globe className={`w-3.5 h-3.5 shrink-0 ${errCls ?? "text-emerald-400"}`} />;
    case "mcp":
      return <Plug className={`w-3.5 h-3.5 shrink-0 ${errCls ?? "text-sky-400"}`} />;
    case "subagent":
      return <Cpu className={`w-3.5 h-3.5 shrink-0 ${errCls ?? "text-accent-soft"}`} />;
    case "todoList":
      return <ListChecks className={`w-3.5 h-3.5 shrink-0 ${errCls ?? "text-accent-soft"}`} />;
    case "other":
      return <Wrench className={`w-3.5 h-3.5 shrink-0 ${errCls ?? "text-muted"}`} />;
  }
}
