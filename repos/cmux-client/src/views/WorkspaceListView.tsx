import { Pin, RefreshCw, Terminal, ChevronRight, FolderGit2, QrCode } from "lucide-react";
import type { WorkspaceNode } from "../protocol/rpc";
import type { ConnectionState } from "../transport/wsClient";
import { Pressable } from "../components/common/Pressable";
import { plainSnippet, shortPath } from "../components/chat/textUtils";

interface WorkspaceListViewProps {
  workspaces: WorkspaceNode[];
  loading: boolean;
  onRefresh: () => void;
  onSelectWorkspace: (workspace: WorkspaceNode) => void;
  hostsCount?: number;
  connState?: ConnectionState;
  onPairHost?: () => void;
}

export function WorkspaceListView({
  workspaces,
  loading,
  onRefresh,
  onSelectWorkspace,
  hostsCount,
  connState,
  onPairHost,
}: WorkspaceListViewProps) {
  const isConnecting = connState === "connecting" || connState === "authenticating";
  const hasNoHosts =
    typeof hostsCount === "number" &&
    hostsCount === 0 &&
    connState !== "connected" &&
    !isConnecting;

  return (
    <div className="flex flex-col h-full w-full max-w-3xl mx-auto bg-[#0a0a0a] text-[#fafafa]">
      <header className="flex items-center justify-between px-4 min-h-[52px] bg-[#141416] border-b border-white/[0.08] w-full shrink-0">
        <div className="flex items-center gap-2.5">
          <h1 className="text-[16px] font-semibold tracking-tight text-[#fafafa]">Workspaces</h1>
          <span className="inline-flex items-center justify-center min-w-[24px] h-6 px-2 rounded-full bg-[#262626] text-[12px] font-medium text-[#a3a3a3] font-mono">
            {workspaces.length}
          </span>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading || hasNoHosts}
          className="w-9 h-9 rounded-xl bg-[#242428] hover:bg-[#2e2e34] active:opacity-75 text-[#e5e5e5] flex items-center justify-center transition-colors disabled:opacity-40"
          title="Refresh workspaces"
          aria-label="Refresh workspaces"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto divide-y divide-white/[0.06] pb-[calc(5rem+env(safe-area-inset-bottom,0px))]">
        {hasNoHosts && !loading && (
          <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <div className="w-16 h-16 rounded-3xl bg-[#1c1c20] border border-white/[0.1] flex items-center justify-center text-[#3276f2] mb-5 shadow-lg">
              <QrCode className="w-8 h-8 text-[#3276f2]" />
            </div>
            <h2 className="text-[20px] font-bold text-white tracking-tight mb-2">
              Welcome to Cmob
            </h2>
            <p className="text-[14px] text-[#a3a3a3] max-w-sm leading-relaxed mb-6">
              Connect your computer to monitor terminal workspaces and control coding agents like
              Claude Code, AGY, and Kiro from your phone.
            </p>
            {onPairHost && (
              <button
                type="button"
                onClick={onPairHost}
                className="inline-flex items-center gap-2 px-5 py-3 rounded-2xl bg-[#3276f2] hover:bg-[#2b66d4] active:scale-[0.98] text-white text-[15px] font-semibold shadow-lg shadow-[#3276f2]/20 transition-all cursor-pointer"
              >
                <QrCode className="w-5 h-5" />
                <span>Connect Your Computer</span>
              </button>
            )}
            <div className="mt-8 p-3.5 rounded-xl bg-[#141416] border border-white/[0.06] text-[12px] text-[#737373] max-w-xs text-left font-mono">
              <span className="text-[#a3a3a3] block mb-1">Terminal command:</span>
              <span className="text-emerald-400">$ cmob qr --tailscale</span>
            </div>
          </div>
        )}

        {!hasNoHosts && workspaces.length === 0 && !loading && (
          <div className="px-6 py-12 text-center text-[#898989] text-[14px]">
            No active workspaces found in cmux.
          </div>
        )}

        {workspaces.map((ws) => {
          const isRunning = ws.status.toLowerCase() === "running";
          const surfaceCount = ws.surfaces.length;

          return (
            <Pressable
              key={ws.id}
              onPress={() => onSelectWorkspace(ws)}
              style={
                ws.color
                  ? {
                      boxShadow: `inset 4px 0 0 ${ws.color}`,
                      backgroundImage: `linear-gradient(90deg, ${ws.color}26, transparent 70%)`,
                    }
                  : undefined
              }
              className="flex items-center justify-between px-4 py-3.5 min-h-[68px] hover:bg-[#141416] active:bg-[#1c1c20] cursor-pointer transition-colors group"
            >
              <div className="flex items-start gap-3 min-w-0 flex-1 pr-3">
                <div
                  style={ws.color ? { backgroundColor: ws.color } : undefined}
                  className="w-10 h-10 rounded-[11px] bg-[#1c1c20] border border-white/[0.07] flex items-center justify-center text-[#a3a3a3] shrink-0 mt-0.5"
                >
                  <FolderGit2 className={`w-5 h-5 ${ws.color ? "text-white" : "text-[#e5e5e5]"}`} />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-[15px] font-semibold text-[#fafafa] truncate">
                      {ws.title}
                    </h2>
                    {ws.pinned && <Pin className="w-3.5 h-3.5 text-[#a3a3a3] shrink-0" />}
                    <span
                      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[12px] font-medium shrink-0 ${
                        isRunning
                          ? "bg-[#3276f2]/15 text-[#8ab4f8]"
                          : "bg-white/[0.06] text-[#898989]"
                      }`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          isRunning ? "bg-[#3276f2]" : "bg-[#737373]"
                        }`}
                      />
                      {isRunning ? "Running" : "Idle"}
                    </span>
                  </div>

                  {ws.snippet && (
                    <p className="mt-1 text-[13px] text-[#a3a3a3] line-clamp-1 leading-snug">
                      {plainSnippet(ws.snippet)}
                    </p>
                  )}

                  <div className="mt-1.5 flex items-center gap-3 text-[12px] text-[#737373] font-mono">
                    <span
                      className="truncate max-w-[210px] sm:max-w-md"
                      title={ws.current_directory}
                    >
                      {shortPath(ws.current_directory)}
                    </span>
                    <span className="flex items-center gap-1 shrink-0 text-[#a3a3a3]">
                      <Terminal className="w-3.5 h-3.5" />
                      {surfaceCount} {surfaceCount === 1 ? "tab" : "tabs"}
                    </span>
                  </div>
                </div>
              </div>

              <ChevronRight className="w-5 h-5 text-[#525252] group-hover:text-[#a3a3a3] transition-colors shrink-0" />
            </Pressable>
          );
        })}
      </div>
    </div>
  );
}
