import { lazy, Suspense, useEffect, useState } from "react";
import { Gauge, RefreshCw, X } from "lucide-react";
import type { UsageSnapshot } from "../../protocol/rpc";
import type { ConnectionState } from "../../transport/wsClient";
import {
  formatUpdatedAgo,
  tightestHeadlineAcrossProviders,
  type UsageTone,
} from "./usageFormatting";

const LazyUsageBody = lazy(() => import("./UsageView").then((m) => ({ default: m.UsageBody })));

const DOT_CLASS: Record<UsageTone, string> = {
  emerald: "bg-status-ok",
  amber: "bg-status-wait",
  rose: "bg-status-err",
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
        className={`h-[26px] px-2 rounded-[6px] text-[11.5px] font-medium inline-flex items-center gap-1.5 transition-colors ${
          open ? "bg-raised text-fg" : "hover:bg-raised text-muted hover:text-fg"
        }`}
      >
        {headline ? (
          <>
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOT_CLASS[headline.tone]}`} />
            <span>{headline.shortName}</span>
            <span className="font-mono text-fg-soft tabular-nums">{headline.usedPercent}%</span>
          </>
        ) : (
          <>
            <Gauge className="w-3.5 h-3.5 text-dim" />
            <span>Quota</span>
          </>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label="Provider usage details"
            className="absolute right-0 top-[calc(100%+6px)] z-50 w-[360px] max-w-[calc(100vw-2rem)] max-h-[75vh] flex flex-col rounded-xl bg-surface border border-line-strong shadow-2xl overflow-hidden select-text"
          >
            <div className="flex items-center justify-between px-3.5 py-2.5 bg-sidebar border-b border-line shrink-0">
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-fg">Model Quota</div>
                <div className="text-[11px] text-dim truncate">
                  {hostName}
                  {snapshot ? ` · ${formatUpdatedAgo(snapshot.updated_at, effectiveNow)}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-0.5 shrink-0">
                <button
                  type="button"
                  onClick={onRefresh}
                  disabled={connState !== "connected" || refreshing || loading}
                  className="w-7 h-7 rounded-md hover:bg-raised text-muted hover:text-fg flex items-center justify-center transition-colors disabled:opacity-40"
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
                  className="w-7 h-7 rounded-md hover:bg-raised text-muted hover:text-fg flex items-center justify-center transition-colors"
                  aria-label="Close"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <div className="overflow-y-auto p-3 scrollbar-sleek bg-bg">
              <Suspense fallback={<div className="h-24" />}>
                <LazyUsageBody
                  connState={connState}
                  snapshot={snapshot}
                  loading={loading}
                  error={error}
                  unsupported={unsupported}
                  now={effectiveNow}
                />
              </Suspense>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
