/** Small text helpers for list previews (the chat body itself is rendered by react-markdown). */

/**
 * One-line, plain-text preview of markdown/XML-ish text (workspace snippets): drops wrapper tags such as
 * `<agent-message from="…">`, markdown markers, and collapses whitespace.
 */
export function plainSnippet(text: string): string {
  return text
    .replace(/<\/?[a-zA-Z][\w:-]*(\s[^<>]*)?>/g, " ")
    .replace(/```[a-zA-Z0-9_-]*/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/gm, "")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Last `keep` segments of a path, so the part that tells folders apart stays visible. */
export function shortPath(path: string, keep = 2): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= keep) return path;
  return `…/${parts.slice(-keep).join("/")}`;
}
