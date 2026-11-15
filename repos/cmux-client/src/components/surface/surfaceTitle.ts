/** Shell tabs are titled with their working directory, which is unreadable once an ellipsis cuts it. */
export function displaySurfaceTitle(title: string, keep = 2): string {
  const t = (title || "").trim();
  if (!t) return "Tab";
  const looksLikePath = /^[~/.…]/.test(t) && !/\s/.test(t);
  if (!looksLikePath) return t;
  const parts = t.split("/").filter((p) => p && p !== "~" && p !== "..." && p !== "…");
  if (parts.length <= keep) return t.replace(/^\.\.\.\/?/, "").replace(/^…\/?/, "") || t;
  return `…/${parts.slice(-keep).join("/")}`;
}
