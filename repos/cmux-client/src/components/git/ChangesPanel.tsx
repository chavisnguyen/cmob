import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, GitBranch, Loader2, RefreshCw } from "lucide-react";
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
  add: "bg-emerald-500/10 text-emerald-300",
  del: "bg-rose-500/10 text-rose-300",
  hunk: "text-accent-soft",
  meta: "text-dim",
  context: "text-fg-soft",
};

function isStaged(f: GitFile): boolean {
  return f.index !== " " && f.index !== "?";
}

/** Read-only view of the working tree changes of a workspace (status, then per-file diff). */
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
  /** Only the newest status request may update the screen (fast refresh / workspace switch). */
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
    void load();
  }, [load]);

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

  const stat = diff ? diffStat(diff.diff) : null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg text-fg">
      <header className="flex items-center gap-2 px-3 pt-[calc(0.5rem+env(safe-area-inset-top,0px))] pb-2 border-b border-white/[0.08] shrink-0">
        <button
          type="button"
          onClick={() => (open ? setOpen(null) : onClose())}
          className="w-9 h-9 rounded-xl bg-raised flex items-center justify-center"
          aria-label="Back"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold truncate">
            {open ? open.file.path : "Changes"}
          </div>
          <div className="text-[12px] text-dim truncate flex items-center gap-1">
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
        {!open && (
          <button
            type="button"
            onClick={() => void load()}
            className="w-9 h-9 rounded-xl bg-raised flex items-center justify-center"
            aria-label="Refresh"
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
          </button>
        )}
      </header>

      <div className="flex-1 overflow-auto">
        {(open ? diffError : error) && (
          <p className="m-4 text-[13px] text-amber-300">{open ? diffError : error}</p>
        )}

        {!open && status && status.files.length === 0 && !error && (
          <p className="m-6 text-center text-[14px] text-muted">Working tree clean.</p>
        )}

        {!open &&
          status?.files.map((f) => (
            <div key={f.path} className="border-b border-white/[0.06] px-4 py-2.5">
              <div className="text-[14px] font-mono break-all">{f.path}</div>
              {f.orig_path && (
                <div className="text-[11.5px] text-dim break-all">from {f.orig_path}</div>
              )}
              <div className="mt-1.5 flex flex-wrap gap-2">
                {isStaged(f) && (
                  <button
                    type="button"
                    onClick={() => setOpen({ file: f, staged: true })}
                    className="h-7 px-2.5 rounded-lg bg-emerald-500/15 text-emerald-300 text-[12px] font-semibold"
                  >
                    Staged · {statusLabel(f.index)}
                  </button>
                )}
                {(f.worktree !== " " && f.worktree !== "?") ||
                (f.index === "?" && f.worktree === "?") ? (
                  <button
                    type="button"
                    onClick={() => setOpen({ file: f, staged: false })}
                    className="h-7 px-2.5 rounded-lg bg-raised text-fg-soft text-[12px] font-semibold"
                  >
                    {f.index === "?" ? "Untracked" : `Unstaged · ${statusLabel(f.worktree)}`}
                  </button>
                ) : null}
              </div>
            </div>
          ))}

        {open && diffLoading && (
          <div className="p-6 flex justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-accent-soft" />
          </div>
        )}
        {open && diff && (
          <pre className="text-[12px] leading-[1.45] font-mono min-w-max pb-6">
            {diff.diff.split("\n").map((line, i) => (
              <div key={i} className={`px-3 whitespace-pre ${LINE_CLASS[classifyDiffLine(line)]}`}>
                {line || " "}
              </div>
            ))}
            {diff.truncated && (
              <div className="px-3 py-2 text-amber-300">
                Diff truncated (too large for the phone).
              </div>
            )}
          </pre>
        )}
      </div>
    </div>
  );
}
