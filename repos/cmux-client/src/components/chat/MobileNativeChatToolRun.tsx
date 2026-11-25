import { memo, useState } from "react";
import {
  Terminal,
  FileText,
  Search,
  Globe,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronUp,
  Cpu,
} from "lucide-react";
import { MobileNativeChatDiffCard } from "./MobileNativeChatDiffCard";

export interface ToolCallItem {
  id: string;
  name: string;
  detail?: string;
  ok?: boolean;
  isEnd?: boolean;
}

interface MobileNativeChatToolRunProps {
  tools: ToolCallItem[];
  live?: boolean;
}

export const MobileNativeChatToolRun = memo(function MobileNativeChatToolRun({
  tools,
  live = false,
}: MobileNativeChatToolRunProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (tools.length === 0) return null;

  // Derive natural language sentence summary (Orca nativeChatToolRunSentence)
  const summary = deriveToolRunSentence(tools, live);
  const allSuccess = tools.every((t) => t.ok !== false);

  return (
    <div className="w-full my-0.5 text-xs font-mono">
      {/* Inline Tool Run Header matching Orca */}
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className="w-full flex items-center justify-between py-1 px-1 rounded-md hover:bg-white/[0.04] text-fg-soft transition-colors"
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1 mr-2">
          {getToolCategoryIcon(tools[0]?.name || "")}
          <span className="font-medium text-fg-soft truncate">{summary}</span>
          {live && (
            <span className="flex h-1.5 w-1.5 relative shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-500" />
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {!live &&
            (allSuccess ? (
              <span className="flex items-center gap-1 text-[10px] px-1 py-0.2 rounded bg-emerald-500/10 text-emerald-400 font-medium">
                <CheckCircle2 className="w-2.5 h-2.5" />
                Done
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[10px] px-1 py-0.2 rounded bg-rose-500/10 text-rose-400 font-medium">
                <XCircle className="w-2.5 h-2.5" />
                Error
              </span>
            ))}
          {isExpanded ? (
            <ChevronUp className="w-3.5 h-3.5 text-muted" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-muted" />
          )}
        </div>
      </button>

      {/* Expanded Inline Member List with Guide Hairline */}
      {isExpanded && (
        <div className="ml-3 pl-2.5 my-1 border-l border-white/10 space-y-1">
          {tools.map((t, idx) => {
            const isEdit = isFileEditTool(t.name);
            const editDetails = isEdit ? parseEditDetails(t.detail) : null;

            return (
              <div key={`${t.id}-${idx}`} className="space-y-1 py-0.5">
                <div className="flex items-start gap-1.5 min-w-0">
                  <div className="mt-0.5 shrink-0">{getToolCategoryIcon(t.name)}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-fg-soft text-[11px] truncate">
                        {t.name}
                      </span>
                      {t.isEnd && (
                        <span
                          className={`text-[9px] px-1 rounded shrink-0 ${
                            t.ok !== false
                              ? "bg-emerald-500/10 text-emerald-400"
                              : "bg-rose-500/10 text-rose-400"
                          }`}
                        >
                          {t.ok !== false ? "success" : "failed"}
                        </span>
                      )}
                    </div>
                    {t.detail && !editDetails && (
                      <p className="mt-0.5 text-muted text-[10px] whitespace-pre-wrap break-all max-h-32 overflow-y-auto scrollbar-thin">
                        {t.detail}
                      </p>
                    )}
                  </div>
                </div>

                {/* Render inline diff card for write/edit operations */}
                {editDetails && (
                  <MobileNativeChatDiffCard
                    path={editDetails.path}
                    diff={editDetails.diff}
                    added={editDetails.added}
                    removed={editDetails.removed}
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

function getToolCategoryIcon(name: string) {
  const lower = name.toLowerCase();
  if (lower.includes("read") || lower.includes("view")) {
    return <FileText className="w-3.5 h-3.5 text-accent-soft" />;
  }
  if (lower.includes("search") || lower.includes("find") || lower.includes("grep")) {
    return <Search className="w-3.5 h-3.5 text-accent-soft" />;
  }
  if (lower.includes("web") || lower.includes("browser") || lower.includes("curl")) {
    return <Globe className="w-3.5 h-3.5 text-emerald-400" />;
  }
  if (lower.includes("subagent") || lower.includes("swarm") || lower.includes("agent")) {
    return <Cpu className="w-3.5 h-3.5 text-accent-soft" />;
  }
  return <Terminal className="w-3.5 h-3.5 text-amber-400" />;
}

function isFileEditTool(name: string): boolean {
  return [
    "edit_file",
    "write_file",
    "Edit",
    "Write",
    "MultiEdit",
    "apply_patch",
    "str_replace",
  ].some((op) => op.toLowerCase() === name.toLowerCase());
}

function parseEditDetails(detail?: string): {
  path: string;
  diff: string;
  added: number;
  removed: number;
} | null {
  if (!detail) return null;
  const match = detail.match(/(?:path|file):\s*([^\n\r]+)/i);
  const path = match ? match[1].trim() : "file";
  const lines = detail.split("\n");
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { path, diff: detail, added, removed };
}

function deriveToolRunSentence(tools: ToolCallItem[], live: boolean): string {
  if (tools.length === 0) return "";
  const first = tools[0].name;
  const count = tools.length;
  const verb = live ? "Running" : "Ran";
  if (count === 1) return `${verb} ${first}`;
  return `${verb} ${first} (+${count - 1} more)`;
}
