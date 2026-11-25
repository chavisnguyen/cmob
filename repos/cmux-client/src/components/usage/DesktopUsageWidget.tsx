import { useEffect, useState } from "react";
import { Gauge, RefreshCw, X } from "lucide-react";
import type { UsageSnapshot } from "../../protocol/rpc";
import type { ConnectionState } from "../../transport/wsClient";
import { UsageBody } from "./UsageView";
import {
  formatUpdatedAgo,
  tightestHeadlineAcrossProviders,
  type UsageTone,
} from "./usageFormatting";

const DOT_CLASS: Record<UsageTone, string> = {
  emerald: "bg-emerald-400",
  amber: "bg-amber-400",
  rose: "bg-rose-400",
};

export function DesktopUsageWidget({
  hostName,
  connState,
  snapshot,
  loading,
  refreshing,
  error,
  unsupported,
  now,
  onRefresh,
}: {
  hostName: string;
  connState: ConnectionState;
  snapshot: UsageSnapshot | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  unsupported: boolean;
  now: number;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [localNow, setLocalNow] = useState(() => Date.now());

  useEffect(() => {
    if (!open) return;
    setLocalNow(Date.now());
    const tick = setInterval(() => setLocalNow(Date.now()), 30_000);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      clearInterval(tick);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const effectiveNow = Math.max(now, localNow);

  const headline = snapshot ? tightestHeadlineAcrossProviders(snapshot.providers) : null;

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Model usage status"
        title="Model & provider quota status"
        className={`h-8 px-2.5 rounded-lg border text-[12px] font-medium inline-flex items-center gap-1.5 transition-colors ${
          open
            ? "bg-bg border-accent/60 text-fg"
            : "bg-raised hover:bg-line border-transparent text-fg-soft"
        }`}
      >
        {headline ? (
          <>
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOT_CLASS[headline.tone]}`} />
            <span>{headline.shortName}</span>
            <span className="font-mono text-fg">{headline.usedPercent}%</span>
          </>
        ) : (
          <>
            <Gauge className="w-3.5 h-3.5 text-muted" />
            <span>Usage</span>
          </>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label="Provider usage details"
            className="absolute right-0 top-[calc(100%+6px)] z-50 w-[380px] max-w-[calc(100vw-2rem)] max-h-[75vh] flex flex-col rounded-2xl bg-bg border border-white/[0.12] shadow-2xl overflow-hidden select-text"
          >
            <div className="flex items-center justify-between px-4 py-2.5 bg-surface border-b border-white/[0.08] shrink-0">
              <div className="min-w-0">
                <div className="text-[14px] font-semibold text-fg">Model Usage</div>
                <div className="text-[11px] text-dim truncate">
                  {hostName}
                  {snapshot ? ` · ${formatUpdatedAgo(snapshot.updated_at, effectiveNow)}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={onRefresh}
                  disabled={connState !== "connected" || refreshing || loading}
                  className="w-8 h-8 rounded-lg hover:bg-raised text-muted hover:text-fg flex items-center justify-center transition-colors disabled:opacity-40"
                  title="Refresh usage"
                  aria-label="Refresh usage"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 ${refreshing || loading ? "animate-spin" : ""}`}
                  />
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="w-8 h-8 rounded-lg hover:bg-raised text-muted hover:text-fg flex items-center justify-center transition-colors"
                  aria-label="Close"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <div className="overflow-y-auto p-3 scrollbar-sleek">
              <UsageBody
                connState={connState}
                snapshot={snapshot}
                loading={loading}
                error={error}
                unsupported={unsupported}
                now={effectiveNow}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
