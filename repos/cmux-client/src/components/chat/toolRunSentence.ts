/**
 * Pure Orca-style Natural Tool Run Sentence Helpers
 *
 * Sources:
 * - ref/orca/src/shared/native-chat/tools/native-chat-tool-run-sentence.ts:12-154
 * - ref/orca/src/shared/native-chat/tools/native-chat-tool-summary.ts:61-175
 * - ref/orca/src/shared/native-chat/tools/native-chat-tool-icon.ts:59-85
 */

import { describeTaskToolCall, isTaskListToolName } from "./taskList";

export interface ToolCallItem {
  id: string;
  name: string;
  inputDetail?: string;
  detail?: string;
  ok?: boolean;
  isEnd?: boolean;
}

export type ToolCategory =
  | "read"
  | "search"
  | "listFiles"
  | "fileChange"
  | "command"
  | "webSearch"
  | "mcp"
  | "subagent"
  | "todoList"
  | "other";

export function classifyToolCategory(name: string): ToolCategory {
  if (isTaskListToolName(name)) return "todoList";
  const lower = name.trim().toLowerCase();
  if (lower.startsWith("mcp__") || lower === "call_mcp_tool") return "mcp";
  if (
    lower === "read" ||
    lower === "read_file" ||
    lower === "view_file" ||
    lower === "read_resource"
  ) {
    return "read";
  }
  if (
    lower === "grep" ||
    lower === "glob" ||
    lower === "search" ||
    lower === "grep_search" ||
    lower === "find_by_name"
  ) {
    return "search";
  }
  if (lower === "ls" || lower === "list" || lower === "list_dir" || lower === "list_resources") {
    return "listFiles";
  }
  if (
    lower === "edit" ||
    lower === "write" ||
    lower === "multiedit" ||
    lower === "edit_file" ||
    lower === "write_file" ||
    lower === "apply_patch" ||
    lower === "str_replace"
  ) {
    return "fileChange";
  }
  if (
    lower === "bash" ||
    lower === "run_command" ||
    lower === "command" ||
    lower === "exec" ||
    lower === "exec_command" ||
    lower === "local_shell"
  ) {
    return "command";
  }
  if (
    lower === "webfetch" ||
    lower === "websearch" ||
    lower === "web_search" ||
    lower === "search_web"
  ) {
    return "webSearch";
  }
  if (
    lower.includes("subagent") ||
    lower.includes("swarm") ||
    lower === "agent" ||
    lower === "task"
  ) {
    return "subagent";
  }
  return "other";
}

function parseInputRecord(raw?: string): Record<string, unknown> | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function unquoteStr(val: unknown): string | null {
  if (typeof val !== "string") return null;
  let s = val.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      const inner: unknown = JSON.parse(s);
      if (typeof inner === "string") s = inner.trim();
    } catch {
      // keep s
    }
  }
  return s.length > 0 ? s : null;
}

function extractFileBasename(tool: ToolCallItem): string | null {
  const rec = parseInputRecord(tool.inputDetail ?? tool.detail);
  const rawPath =
    unquoteStr(rec?.Path) ??
    unquoteStr(rec?.file_path) ??
    unquoteStr(rec?.filePath) ??
    unquoteStr(rec?.path) ??
    unquoteStr(rec?.TargetFile);
  if (!rawPath) return null;
  const parts = rawPath.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? rawPath;
}

function extractCommandDisplay(tool: ToolCallItem): string | null {
  const rec = parseInputRecord(tool.inputDetail ?? tool.detail);
  if (rec) {
    const summary =
      unquoteStr(rec.description) ??
      unquoteStr(rec.toolSummary) ??
      unquoteStr(rec.command) ??
      unquoteStr(rec.CommandLine) ??
      unquoteStr(rec.cmd);
    if (summary) return summary;
  }
  const plain = (tool.inputDetail ?? tool.detail)?.trim();
  if (plain && !plain.startsWith("{") && !plain.startsWith("[")) {
    return plain.split("\n")[0]?.slice(0, 80) ?? null;
  }
  return null;
}

export function formatSingleToolMemberLabel(tool: ToolCallItem): string {
  const file = extractFileBasename(tool);
  if (file) return `${tool.name} · ${file}`;
  const cmd = extractCommandDisplay(tool);
  if (cmd && classifyToolCategory(tool.name) === "command") return cmd;
  return tool.name;
}

export function parseEditDetails(detail?: string): {
  path: string;
  diff: string;
  added: number;
  removed: number;
} | null {
  if (!detail) return null;
  const rec = parseInputRecord(detail);
  if (rec) {
    const path =
      unquoteStr(rec.Path) ??
      unquoteStr(rec.file_path) ??
      unquoteStr(rec.filePath) ??
      unquoteStr(rec.path);
    const oldStr = unquoteStr(rec.Target) ?? unquoteStr(rec.old_string);
    const newStr = unquoteStr(rec.Replacement) ?? unquoteStr(rec.new_string);
    if (path && (oldStr !== null || newStr !== null)) {
      const removedLines = oldStr ? oldStr.split("\n").map((l) => `-${l}`) : [];
      const addedLines = newStr ? newStr.split("\n").map((l) => `+${l}`) : [];
      return {
        path,
        diff: [...removedLines, ...addedLines].join("\n"),
        added: addedLines.length,
        removed: removedLines.length,
      };
    }
  }
  const match = detail.match(/(?:path|file):\s*([^\n\r]+)/i);
  if (!match) return null;
  const path = match[1].trim();
  const lines = detail.split("\n");
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  if (added === 0 && removed === 0) return null;
  return { path, diff: detail, added, removed };
}

function categoryClause(cat: ToolCategory, items: ToolCallItem[], live: boolean): string {
  const count = items.length;
  const uniqueFiles = Array.from(
    new Set(items.map(extractFileBasename).filter((f): f is string => Boolean(f))),
  );

  switch (cat) {
    case "read": {
      if (count === 1 && uniqueFiles[0]) {
        return `${live ? "Reading" : "Read"} ${uniqueFiles[0]}`;
      }
      const tail =
        uniqueFiles.length > 0 && uniqueFiles.length <= 3 ? ` (${uniqueFiles.join(", ")})` : "";
      return `${live ? "Reading" : "Read"} ${count} ${count === 1 ? "file" : "files"}${tail}`;
    }
    case "fileChange": {
      if (count === 1 && uniqueFiles[0]) {
        return `${live ? "Editing" : "Edited"} ${uniqueFiles[0]}`;
      }
      const tail =
        uniqueFiles.length > 0 && uniqueFiles.length <= 2 ? ` (${uniqueFiles.join(", ")})` : "";
      return `${live ? "Editing" : "Edited"} ${count} ${count === 1 ? "file" : "files"}${tail}`;
    }
    case "search":
      return `${live ? "Searching" : "Searched"}${count > 1 ? ` ${count} times` : ""}`;
    case "listFiles":
      return `${live ? "Listing" : "Listed"} ${count} ${count === 1 ? "directory" : "directories"}`;
    case "command": {
      if (count === 1) {
        const cmd = extractCommandDisplay(items[0]);
        if (cmd) {
          return live ? `Running ${cmd}` : cmd;
        }
      }
      return `${live ? "Running" : "Ran"} ${count} ${count === 1 ? "command" : "commands"}`;
    }
    case "webSearch":
      return `${live ? "Searching the web" : "Searched the web"}${count > 1 ? ` ${count} times` : ""}`;
    case "mcp":
      return `${live ? "Using" : "Used"} ${count} ${count === 1 ? "integration" : "integrations"}`;
    case "subagent":
      return `${live ? "Running" : "Ran"} ${count} ${count === 1 ? "agent" : "agents"}`;
    case "todoList": {
      const last = items[items.length - 1];
      const info = describeTaskToolCall(last.name, last.inputDetail ?? last.detail);
      return info ? info.headline : live ? "Updating tasks" : "Updated tasks";
    }
    case "other":
      return count === 1
        ? `${live ? "Using" : "Used"} ${items[0].name}`
        : `${live ? "Using" : "Used"} ${count} tools`;
  }
}

export function deriveToolRunSentence(tools: ToolCallItem[], live: boolean): string {
  if (tools.length === 0) return "";

  const groups = new Map<ToolCategory, ToolCallItem[]>();
  for (const t of tools) {
    const cat = classifyToolCategory(t.name);
    const list = groups.get(cat);
    if (list) list.push(t);
    else groups.set(cat, [t]);
  }

  const clauses = Array.from(groups.entries()).map(([cat, items], idx) => {
    const raw = categoryClause(cat, items, live);
    if (idx === 0 || raw.length === 0) return raw;
    return `${raw[0].toLowerCase()}${raw.slice(1)}`;
  });

  if (clauses.length === 1) return clauses[0];
  if (clauses.length === 2) return `${clauses[0]} and ${clauses[1]}`;
  return `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
}
