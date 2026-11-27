import { memo } from "react";
import {
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
import { describeTaskToolCall, formatChatDuration } from "../../domain/chat/taskList";
import {
  classifyToolCategory,
  deriveToolRunSentence,
  formatSingleToolMemberLabel,
  parseEditDetails,
  type ToolCategory,
} from "../../domain/chat/toolRunSentence";
import type { ThoughtStepItem, ToolCallItem, WorkRunStepItem } from "../../domain/chat/types";
import { useChatDisclosure } from "../../state/useChatDisclosure";
import { TaskChecklistRows } from "./ChatWorkPrimitives";
import { MobileNativeChatDiffCard } from "./MobileNativeChatDiffCard";

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
    <div className="w-full my-0.5 text-[12px]">
      <button
        type="button"
        aria-expanded={isExpanded}
        onClick={toggleExpanded}
        className="group w-full flex items-center justify-between py-0.5 px-1 -mx-1 rounded-[5px] hover:bg-surface/80 text-muted hover:text-fg-soft transition-colors min-w-0"
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1 mr-2">
          {isExpanded ? (
            <ChevronDown className="w-3 h-3 text-dim shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 text-dim shrink-0" />
          )}
          {renderCategoryIcon(primaryCategory, !allSuccess)}
          <span className="truncate font-sans">{summary}</span>
          {live && (
            <span className="inline-flex rounded-full h-1.5 w-1.5 bg-status-run animate-pulse shrink-0" />
          )}
        </div>
        {!live && !allSuccess && (
          <span className="flex items-center gap-1 text-[10.5px] text-status-err font-medium shrink-0">
            <XCircle className="w-3 h-3" />
            Failed
          </span>
        )}
      </button>

      {isExpanded && (
        <div className="ml-2.5 pl-3 my-1 border-l border-line space-y-1.5">
          {effectiveSteps.map((step, idx) => {
            if (step.kind === "thinking") {
              return (
                <div
                  key={`thought-${step.thought.id}-${idx}`}
                  className="py-0.5 space-y-0.5 text-[11.5px] font-sans text-muted"
                >
                  <div className="text-dim font-medium">
                    {step.thought.durationSeconds && step.thought.durationSeconds > 0
                      ? `Thought for ${formatChatDuration(step.thought.durationSeconds)}`
                      : "Thought"}
                  </div>
                  <p className="whitespace-pre-wrap leading-relaxed max-h-44 overflow-y-auto scrollbar-thin">
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
                      <span className="text-fg-soft text-[11.5px] font-mono truncate">
                        {itemLabel}
                      </span>
                      {t.isEnd && t.ok === false && (
                        <span className="text-[10px] shrink-0 text-status-err">failed</span>
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
                        <p className="mt-0.5 text-dim text-[11px] font-mono whitespace-pre-wrap break-all max-h-28 overflow-y-auto scrollbar-thin">
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

const CATEGORY_TONE: Record<ToolCategory, string> = {
  read: "text-[#82a8c9]",
  search: "text-[#82a8c9]",
  listFiles: "text-[#82a8c9]",
  fileChange: "text-status-wait",
  command: "text-status-ok",
  webSearch: "text-[#78b7b2]",
  mcp: "text-[#b49ae2]",
  subagent: "text-accent-soft",
  todoList: "text-accent",
  other: "text-muted",
};

function renderCategoryIcon(cat: ToolCategory, failed = false) {
  const cls = `w-3 h-3 shrink-0 ${failed ? "text-status-err" : CATEGORY_TONE[cat]}`;
  switch (cat) {
    case "read":
      return <Eye className={cls} />;
    case "search":
      return <Search className={cls} />;
    case "listFiles":
      return <Folder className={cls} />;
    case "fileChange":
      return <Pencil className={cls} />;
    case "command":
      return <SquareTerminal className={cls} />;
    case "webSearch":
      return <Globe className={cls} />;
    case "mcp":
      return <Plug className={cls} />;
    case "subagent":
      return <Cpu className={cls} />;
    case "todoList":
      return <ListChecks className={cls} />;
    case "other":
      return <Wrench className={cls} />;
  }
}
