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
  onResetZoom: () => void;
  onToggleKeyBar: () => void;
  onToggleViewportMode: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-3 min-h-[40px] bg-bg border-b border-white/[0.07] text-muted shrink-0 gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <span
          className={`inline-flex items-center gap-1.5 text-[11px] font-sans font-medium px-2 py-0.5 rounded-md ${
            connState === "connected"
              ? "text-emerald-400 bg-emerald-500/10"
              : "text-amber-300 bg-amber-500/10"
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              connState === "connected" ? "bg-emerald-400" : "bg-amber-400"
            }`}
          />
          <span>{subscribed ? "Live" : "Sync"}</span>
        </span>

        <span
          className="text-[11px] text-dim font-mono shrink-0"
          title="Terminal size (columns × rows)"
        >
          {gridDims.cols}×{gridDims.rows}
        </span>

        {tty && (
          <span className="text-dim font-mono text-[12px] truncate hidden sm:inline">{tty}</span>
        )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0 font-sans">
        {viewportMode === "desktop" && userScale > 1.02 && (
          <button
            type="button"
            onClick={onResetZoom}
            className="h-8 px-2.5 rounded-lg bg-raised border border-white/[0.12] text-[12px] font-semibold text-accent-soft hover:text-white"
            title="Reset zoom"
          >
            1×
          </button>
        )}

        <button
          type="button"
          onClick={onToggleKeyBar}
          className={`w-8 h-8 rounded-lg border transition-colors flex items-center justify-center ${
            showKeyBar
              ? "bg-raised border-white/[0.14] text-fg"
              : "bg-bg border-white/[0.08] text-muted hover:text-fg hover:bg-raised"
          }`}
          title={showKeyBar ? "Hide key bar" : "Show key bar"}
          aria-label={showKeyBar ? "Hide key bar" : "Show key bar"}
          aria-pressed={showKeyBar}
        >
          <Keyboard className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={onToggleViewportMode}
          aria-label={
            viewportMode === "mobile" ? "Switch to mirror Mac size" : "Switch to fit pane size"
          }
          className={`flex items-center justify-center w-9 h-8 rounded-lg border transition-colors ${
            viewportMode === "desktop"
              ? "bg-accent border-accent text-white"
              : "bg-raised border-white/[0.08] text-fg hover:bg-line"
          }`}
          title={
            viewportMode === "mobile"
              ? "Mirror Mac window size (full Mac cols×rows)"
              : "Fit terminal to this pane (crisp 1:1 cols×rows)"
          }
        >
          {viewportMode === "desktop" ? (
            <Monitor className="w-4 h-4" />
          ) : (
            <Smartphone className="w-4 h-4 text-[#86efac]" />
          )}
        </button>

        <button
          type="button"
          onClick={onRefresh}
          className="w-8 h-8 rounded-lg bg-raised hover:bg-line text-fg-soft flex items-center justify-center transition-colors"
          title="Refresh terminal"
          aria-label="Refresh terminal"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? "animate-spin" : ""}`} />
        </button>
      </div>
    </div>
  );
}
