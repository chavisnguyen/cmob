const MD_EXT = /\.(?:md|mdx|markdown)$/i;
// Characters that never appear in a plain file path an agent would mention.
const BAD_CHARS = /[\s<>|*?"`$(){}[\]\\]/;

/**
 * Returns the cleaned markdown file path if `text` (inline code content or a link href) names one,
 * else null. Accepts relative, absolute and `file://` paths; strips `:line[:col]` and `#fragment`.
 */
export function parseMarkdownPath(text: string): string | null {
  let s = text.trim();
  if (!s || s.length > 1024) return null;
  if (/^(?:https?|mailto|data|javascript):/i.test(s) || s.startsWith("#")) return null;
  let decoded = false;
  if (s.startsWith("file://")) {
    s = s.slice("file://".length).replace(/#.*$/, "");
    // Validate the still-encoded form (a file URL has no raw spaces); the decoded path may have them.
    if (BAD_CHARS.test(s)) return null;
    try {
      s = decodeURIComponent(s);
    } catch {
      return null;
    }
    decoded = true;
  }
  s = s.replace(/#.*$/, "").replace(/:\d+(?::\d+)?$/, "");
  if (!s || (!decoded && BAD_CHARS.test(s)) || s.includes("\0") || !MD_EXT.test(s)) return null;
  return s;
}

/** Resolves `target` against the directory of `basePath` (both workspace-relative or absolute). */
export function resolveSiblingPath(basePath: string, target: string): string {
  if (target.startsWith("/")) return target;
  const baseDir = basePath.includes("/") ? basePath.slice(0, basePath.lastIndexOf("/")) : "";
  const absolute = basePath.startsWith("/");
  const out: string[] = [];
  for (const seg of `${baseDir}/${target}`.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push(seg);
  }
  return (absolute ? "/" : "") + out.join("/");
}
