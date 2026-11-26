import { Keyboard, Monitor, RefreshCw, Smartphone } from "lucide-react";
import type { TerminalViewportMode } from "../../domain/terminalState";
import type { ConnectionState } from "../../transport/wsClient";

export function TerminalToolbar({
  connState,
  subscribed,
  gridDims,
  tty,
  viewportMode,
  userScale,
  showKeyBar,
  isRefreshing,
  bottomBar = false,
  onResetZoom,
  onToggleKeyBar,
  onToggleViewportMode,
  onRefresh,
}: {
  connState: ConnectionState;
  subscribed: boolean;
  gridDims: { cols: number; rows: number };
  tty?: string;
  viewportMode: TerminalViewportMode;
  userScale: number;
  showKeyBar: boolean;
  isRefreshing: boolean;
  bottomBar?: boolean;
  onResetZoom: () => void;
  onToggleKeyBar: () => void;
  onToggleViewportMode: () => void;
  onRefresh: () => void;
}) {
  return (
    <div
      className={`flex items-center justify-between px-3 shrink-0 gap-2 select-none ${
        bottomBar
          ? "h-[26px] bg-sidebar border-t border-line text-[11px]"
          : "min-h-[34px] bg-sidebar border-b border-line text-[11.5px]"
      } text-muted`}
    >
      <div className="flex items-center gap-2 min-w-0 font-mono">
        <span className="inline-flex items-center gap-1.5 font-sans text-muted">
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              connState === "connected" ? "bg-status-ok" : "bg-status-wait"
            }`}
          />
          <span>{subscribed ? "Live" : "Sync"}</span>
        </span>

        <span className="text-dim shrink-0" title="Terminal size (columns × rows)">
          {gridDims.cols}×{gridDims.rows}
        </span>

        {tty && <span className="text-dim truncate hidden sm:inline">· {tty}</span>}
      </div>

      <div className="flex items-center gap-1 shrink-0 font-sans">
        {viewportMode === "desktop" && userScale > 1.02 && (
          <button
            type="button"
            onClick={onResetZoom}
            className="h-5 px-1.5 rounded bg-raised text-[11px] font-mono text-fg hover:bg-line-strong"
            title="Reset zoom"
          >
            1×
          </button>
        )}

        <button
          type="button"
          onClick={onToggleKeyBar}
          className={`h-[22px] px-1.5 rounded-[4px] transition-colors flex items-center gap-1 text-[11px] ${
            showKeyBar ? "bg-raised text-fg" : "text-muted hover:text-fg hover:bg-raised/70"
          }`}
          title={showKeyBar ? "Hide key bar" : "Show key bar"}
          aria-label={showKeyBar ? "Hide key bar" : "Show key bar"}
          aria-pressed={showKeyBar}
        >
          <Keyboard className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Keys</span>
        </button>

        <button
          type="button"
          onClick={onToggleViewportMode}
          aria-label={
            viewportMode === "mobile" ? "Switch to mirror Mac size" : "Switch to fit pane size"
          }
          className={`h-[22px] px-1.5 rounded-[4px] transition-colors flex items-center gap-1 text-[11px] ${
            viewportMode === "desktop"
              ? "bg-raised text-fg"
              : "text-muted hover:text-fg hover:bg-raised/70"
          }`}
          title={
            viewportMode === "mobile"
              ? "Mirror Mac window size (full Mac cols×rows)"
              : "Fit terminal to this pane (crisp 1:1 cols×rows)"
          }
        >
          {viewportMode === "desktop" ? (
            <Monitor className="w-3.5 h-3.5" />
          ) : (
            <Smartphone className="w-3.5 h-3.5" />
          )}
          <span className="hidden sm:inline">{viewportMode === "desktop" ? "Mirror" : "Fit"}</span>
        </button>

        <button
          type="button"
          onClick={onRefresh}
          className="w-[22px] h-[22px] rounded-[4px] hover:bg-raised text-muted hover:text-fg flex items-center justify-center transition-colors"
          title="Refresh terminal"
          aria-label="Refresh terminal"
        >
          <RefreshCw className={`w-3 h-3 ${isRefreshing ? "animate-spin" : ""}`} />
        </button>
      </div>
    </div>
  );
}
