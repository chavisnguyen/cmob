/** Classifies unified-diff lines for colouring. Pure, so it is unit tested. */

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context";

export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file mode") ||
    line.startsWith("deleted file mode") ||
    line.startsWith("similarity index") ||
    line.startsWith("rename ") ||
    line.startsWith("Binary files")
  ) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

export interface DiffStat {
  added: number;
  removed: number;
}

/** Counts added/removed lines, ignoring the `+++`/`---` file headers. */
export function diffStat(diff: string): DiffStat {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    const kind = classifyDiffLine(line);
    if (kind === "add") added += 1;
    else if (kind === "del") removed += 1;
  }
  return { added, removed };
}

/** Human label for a porcelain status letter. */
export function statusLabel(letter: string): string {
  switch (letter) {
    case "M":
      return "Modified";
    case "A":
      return "Added";
    case "D":
      return "Deleted";
    case "R":
      return "Renamed";
    case "C":
      return "Copied";
    case "U":
      return "Conflict";
    case "?":
      return "Untracked";
    default:
      return letter.trim() || "";
  }
}
