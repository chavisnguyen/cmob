import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronLeft, GitBranch, Loader2, RefreshCw, X } from "lucide-react";
import { RPC_METHODS } from "../../protocol/rpc";
import { wsClient } from "../../transport/wsClient";
import { classifyDiffLine, diffStat, statusLabel, type DiffLineKind } from "./diffLines";

interface GitFile {
  path: string;
  index: string;
  worktree: string;
  orig_path?: string;
}
interface GitStatus {
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: GitFile[];
}
interface DiffResult {
  diff: string;
  truncated: boolean;
}

const LINE_CLASS: Record<DiffLineKind, string> = {
  add: "bg-status-ok/10 text-status-ok",
  del: "bg-status-err/10 text-status-err",
  hunk: "text-muted bg-sidebar",
  meta: "text-dim",
  context: "text-fg-soft",
};

const DIFF_LINE_HEIGHT_PX = 20;

function isStaged(f: GitFile): boolean {
  return f.index !== " " && f.index !== "?";
}

function VirtualizedChangesDiff({
  lines,
  truncated,
  scrollElementRef,
}: {
  lines: string[];
  truncated: boolean;
  scrollElementRef: RefObject<HTMLDivElement | null>;
}) {
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => DIFF_LINE_HEIGHT_PX,
    overscan: 20,
    scrollMargin: 8,
  });

  useEffect(() => {
    if (scrollElementRef.current) {
      scrollElementRef.current.scrollTop = 0;
    }
  }, [lines, scrollElementRef]);

  const virtualItems = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();
  const first = virtualItems[0];
  const last = virtualItems[virtualItems.length - 1];
  const topSpacer = first ? Math.max(0, first.start - 8) : 0;
  const bottomSpacer = last ? Math.max(0, totalHeight - (last.end - 8)) : 0;

  return (
    <pre className="text-[12px] leading-[20px] font-mono min-w-max pb-6 pt-2">
      {topSpacer > 0 && (
        <div aria-hidden="true" style={{ height: topSpacer, overflowAnchor: "none" }} />
      )}
      {virtualItems.map((item) => {
        const line = lines[item.index] ?? "";
        return (
          <div
            key={item.key}
            className={`h-[20px] px-3 whitespace-pre ${LINE_CLASS[classifyDiffLine(line)]}`}
          >
            {line || " "}
          </div>
        );
      })}
      {bottomSpacer > 0 && (
        <div aria-hidden="true" style={{ height: bottomSpacer, overflowAnchor: "none" }} />
      )}
      {truncated && (
        <div className="px-3 py-2 text-status-wait">Diff truncated (too large for the client).</div>
      )}
    </pre>
  );
}

export function ChangesPanel({
  workspaceId,
  workspaceTitle,
  onClose,
}: {
  workspaceId: string;
  workspaceTitle: string;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<{ file: GitFile; staged: boolean } | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = (loadSeq.current += 1);
    setLoading(true);
    setError(null);
    try {
      const resp = await wsClient.call<{ status: GitStatus }>(RPC_METHODS.GIT_STATUS, {
        workspace_id: workspaceId,
      });
      if (seq === loadSeq.current) setStatus(resp.status);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setStatus(null);
      setError(err instanceof Error ? err.message : "Could not read git status.");
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    setOpen(null);
    void load();
  }, [load]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!open) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    setDiff(null);
    setDiffError(null);
    wsClient
      .call<DiffResult>(RPC_METHODS.GIT_DIFF, {
        workspace_id: workspaceId,
        path: open.file.path,
        staged: open.staged,
      })
      .then((r) => !cancelled && setDiff(r))
      .catch(
        (err) =>
          !cancelled && setDiffError(err instanceof Error ? err.message : "Could not read diff."),
      )
      .finally(() => !cancelled && setDiffLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId]);

  const diffScrollRef = useRef<HTMLDivElement>(null);
  const stat = useMemo(() => (diff ? diffStat(diff.diff) : null), [diff]);
  const diffLines = useMemo(() => (diff ? diff.diff.split("\n") : []), [diff]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col lg:items-center lg:justify-center lg:p-6 bg-bg lg:bg-black/65 lg:backdrop-blur-[1px] text-fg select-text"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Git changes"
        onClick={(e) => e.stopPropagation()}
        className="flex flex-col flex-1 min-h-0 w-full lg:flex-initial lg:w-full lg:max-w-5xl lg:h-[82vh] lg:rounded-xl lg:bg-bg lg:border lg:border-line-strong lg:shadow-2xl overflow-hidden"
      >
        <header className="flex items-center gap-2 px-3 pt-[calc(0.5rem+env(safe-area-inset-top,0px))] lg:pt-2 pb-2 bg-sidebar border-b border-line shrink-0">
          <button
            type="button"
            onClick={() => (open ? setOpen(null) : onClose())}
            className="w-8 h-8 rounded-md hover:bg-raised flex items-center justify-center lg:hidden"
            aria-label="Back"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-semibold truncate">
              <span className="lg:hidden">{open ? open.file.path : "Changes"}</span>
              <span className="hidden lg:inline">Changes{open ? ` · ${open.file.path}` : ""}</span>
            </div>
            <div className="text-[11.5px] text-dim font-mono truncate flex items-center gap-1">
              {open ? (
                <span>
                  {open.staged ? "Staged" : "Unstaged"}
                  {stat ? ` · +${stat.added} −${stat.removed}` : ""}
                </span>
              ) : (
                <>
                  <GitBranch className="w-3 h-3" />
                  <span>
                    {status?.branch ?? workspaceTitle}
                    {status && (status.ahead > 0 || status.behind > 0)
                      ? ` · ↑${status.ahead} ↓${status.behind}`
                      : ""}
                  </span>
                </>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className={`w-7 h-7 rounded-md hover:bg-raised text-muted hover:text-fg items-center justify-center ${
              open ? "hidden lg:flex" : "flex"
            }`}
            aria-label="Refresh"
          >
            {loading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="hidden lg:flex w-7 h-7 rounded-md hover:bg-raised items-center justify-center text-muted hover:text-fg"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
          <div
            className={`${
              open ? "hidden lg:block" : "block"
            } flex-1 lg:flex-none lg:w-76 lg:shrink-0 bg-sidebar lg:border-r lg:border-line overflow-y-auto divide-y divide-line`}
          >
            {error && <p className="m-4 text-[12.5px] text-status-wait">{error}</p>}

            {status && status.files.length === 0 && !error && (
              <p className="m-6 text-center text-[13px] text-muted">Working tree clean.</p>
            )}

            {status?.files.map((f) => {
              const isSelected = open?.file.path === f.path;
              return (
                <div
                  key={f.path}
                  className={`px-3.5 py-2.5 transition-colors ${isSelected ? "bg-raised/60" : ""}`}
                >
                  <div className="text-[12.5px] font-mono text-fg break-all">{f.path}</div>
                  {f.orig_path && (
                    <div className="text-[11px] text-dim break-all">from {f.orig_path}</div>
                  )}
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {isStaged(f) && (
                      <button
                        type="button"
                        onClick={() => setOpen({ file: f, staged: true })}
                        className={`h-6 px-2 rounded text-[11px] font-medium ${
                          open?.file.path === f.path && open.staged
                            ? "bg-status-ok/25 text-status-ok ring-1 ring-status-ok/50"
                            : "bg-status-ok/10 text-status-ok hover:bg-status-ok/20"
                        }`}
                      >
                        Staged · {statusLabel(f.index)}
                      </button>
                    )}
                    {(f.worktree !== " " && f.worktree !== "?") ||
                    (f.index === "?" && f.worktree === "?") ? (
                      <button
                        type="button"
                        onClick={() => setOpen({ file: f, staged: false })}
                        className={`h-6 px-2 rounded text-[11px] font-medium ${
                          open?.file.path === f.path && !open.staged
                            ? "bg-fg text-bg"
                            : "bg-raised text-fg-soft hover:bg-line-strong"
                        }`}
                      >
                        {f.index === "?" ? "Untracked" : `Unstaged · ${statusLabel(f.worktree)}`}
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>

          <div
            ref={diffScrollRef}
            className={`${open ? "block" : "hidden lg:block"} flex-1 overflow-auto bg-[#10100f]`}
          >
            {!open && (
              <div className="h-full flex items-center justify-center p-6 text-[12.5px] text-dim">
                Select a file on the left to inspect its diff.
              </div>
            )}
            {open && diffError && <p className="m-4 text-[12.5px] text-status-wait">{diffError}</p>}
            {open && diffLoading && (
              <div className="p-6 flex justify-center">
                <Loader2 className="w-4 h-4 animate-spin text-muted" />
              </div>
            )}
            {open && diff && (
              <VirtualizedChangesDiff
                lines={diffLines}
                truncated={diff.truncated}
                scrollElementRef={diffScrollRef}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
