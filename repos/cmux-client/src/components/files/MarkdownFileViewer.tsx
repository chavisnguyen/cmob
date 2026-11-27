import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, FileText, Loader2, RefreshCw, X } from "lucide-react";
import { ChatFileLinkContext } from "../chat/ChatFileLinkContext";
import { resolveSiblingPath } from "../chat/mdPath";
import { NativeChatProse } from "../chat/NativeChatProse";
import { RPC_METHODS, type FileReadResult } from "../../protocol/rpc";
import { wsClient } from "../../transport/wsClient";

const POLL_MS = 4_000;

/**
 * Read-only viewer for a markdown/text file in the workspace, opened by tapping a path in chat
 * (the phone counterpart of cmux's `cmux markdown open` panel). Re-checks the file every few
 * seconds while visible and re-renders when it changes on disk.
 */
export function MarkdownFileViewer({
  workspaceId,
  initialPath,
  onClose,
}: {
  workspaceId: string;
  initialPath: string;
  onClose: () => void;
}) {
  const [stack, setStack] = useState<string[]>([initialPath]);
  const path = stack[stack.length - 1];
  const [file, setFile] = useState<FileReadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mtimeRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);

  const load = useCallback(
    async (opts: { reset: boolean }) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const res = await wsClient.call<FileReadResult>(RPC_METHODS.FILE_READ, {
          workspace_id: workspaceId,
          path,
          ...(opts.reset || mtimeRef.current === null ? {} : { since_mtime_ms: mtimeRef.current }),
        });
        mtimeRef.current = res.mtime_ms;
        setError(null);
        if (!res.unchanged) setFile(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not open file.");
      } finally {
        inFlightRef.current = false;
        setLoading(false);
      }
    },
    [workspaceId, path],
  );

  useEffect(() => {
    mtimeRef.current = null;
    setFile(null);
    setError(null);
    setLoading(true);
    void load({ reset: true });
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load({ reset: false });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Links inside the document resolve relative to this file, not the workspace root.
  const openLinked = useMemo(
    () => (target: string) => setStack((s) => [...s, resolveSiblingPath(s[s.length - 1], target)]),
    [],
  );

  const isText = (file?.name ?? path).toLowerCase().endsWith(".txt");

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col lg:items-center lg:justify-center lg:p-6 bg-bg lg:bg-black/65 lg:backdrop-blur-[1px] text-fg select-text"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Markdown file"
        onClick={(e) => e.stopPropagation()}
        className="flex flex-col flex-1 min-h-0 w-full lg:flex-initial lg:max-w-3xl lg:h-[85vh] lg:rounded-xl lg:bg-bg lg:border lg:border-line-strong lg:shadow-2xl overflow-hidden"
      >
        <header className="flex items-center gap-1 px-2 h-[44px] bg-sidebar border-b border-line shrink-0 pt-[env(safe-area-inset-top,0px)] box-content">
          {stack.length > 1 ? (
            <button
              type="button"
              onClick={() => setStack((s) => s.slice(0, -1))}
              className="w-8 h-8 rounded-md hover:bg-raised text-muted hover:text-fg flex items-center justify-center"
              aria-label="Back"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          ) : (
            <FileText className="w-4 h-4 text-accent mx-2 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-fg truncate">
              {file?.name ?? path.split("/").pop()}
            </div>
            <div className="text-[11px] text-dim font-mono truncate">{file?.path ?? path}</div>
          </div>
          <button
            type="button"
            onClick={() => void load({ reset: true })}
            className="w-8 h-8 rounded-md hover:bg-raised text-muted hover:text-fg flex items-center justify-center"
            title="Reload"
            aria-label="Reload file"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-md hover:bg-raised text-muted hover:text-fg flex items-center justify-center"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-sleek px-4 py-4 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))]">
          {loading && !file && (
            <div className="flex items-center justify-center py-12 text-muted gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-[12.5px]">Opening…</span>
            </div>
          )}
          {error && (
            <div className="rounded-lg bg-status-err/10 border border-status-err/25 px-3 py-2 text-[12.5px] text-status-err">
              {error}
            </div>
          )}
          {file && (
            <ChatFileLinkContext.Provider value={openLinked}>
              {file.truncated && (
                <div className="mb-3 rounded-lg bg-status-wait/10 border border-status-wait/25 px-3 py-2 text-[12px] text-status-wait">
                  File is large — showing the first part only.
                </div>
              )}
              {isText ? (
                <pre className="whitespace-pre-wrap break-words text-[12.5px] font-mono text-fg-soft">
                  {file.content}
                </pre>
              ) : (
                <NativeChatProse content={file.content} />
              )}
            </ChatFileLinkContext.Provider>
          )}
        </div>
      </div>
    </div>
  );
}
