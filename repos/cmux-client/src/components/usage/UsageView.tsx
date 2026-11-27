import { Gauge, Loader2, RefreshCw } from "lucide-react";
import type { ProviderUsage, UsageSnapshot } from "../../protocol/rpc";
import type { ConnectionState } from "../../transport/wsClient";
import { AgentIcon } from "../common/AgentIcon";
import {
  clampUsedPercent,
  formatResetCountdown,
  formatUpdatedAgo,
  usageTone,
  windowLabel,
  type UsageTone,
} from "./usageFormatting";

const BAR_CLASS: Record<UsageTone, string> = {
  emerald: "bg-status-ok",
  amber: "bg-status-wait",
  rose: "bg-status-err",
};

const TEXT_CLASS: Record<UsageTone, string> = {
  emerald: "text-status-ok",
  amber: "text-status-wait",
  rose: "text-status-err",
};

function UsageMeterRow({
  label,
  sublabel,
  usedPercent,
  resetsAt,
  now,
}: {
  label: string;
  sublabel?: string;
  usedPercent: number;
  resetsAt?: number;
  now: number;
}) {
  const used = clampUsedPercent(usedPercent);
  const tone = usageTone(used);
  const resetText = formatResetCountdown(resetsAt, now);

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <span className="text-[12.5px] font-medium text-fg-soft">{label}</span>
          {sublabel && <p className="text-[11px] text-dim truncate">{sublabel}</p>}
        </div>
        <span
          className={`text-[12px] font-mono tabular-nums font-medium shrink-0 ${TEXT_CLASS[tone]}`}
        >
          {used}%
        </span>
      </div>
      <div className="h-1 w-full rounded-full bg-raised overflow-hidden">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ease-out ${BAR_CLASS[tone]}`}
          style={{ width: `${used}%` }}
        />
      </div>
      {resetText && <div className="text-[11px] text-dim font-mono">{resetText}</div>}
    </div>
  );
}

function ProviderUsageCard({ provider, now }: { provider: ProviderUsage; now: number }) {
  const hasBuckets = Boolean(provider.buckets && provider.buckets.length > 0);

  return (
    <div className="rounded-xl bg-sidebar border border-line p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-7 h-7 rounded-md bg-surface border border-line flex items-center justify-center shrink-0">
            <AgentIcon kind={provider.provider} size={15} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-[13.5px] font-semibold text-fg truncate">
                {provider.display_name}
              </h2>
              {provider.plan_type && (
                <span className="px-1.5 py-0.2 rounded bg-raised text-[10px] font-mono uppercase tracking-wider text-muted">
                  {provider.plan_type}
                </span>
              )}
            </div>
            <p className="text-[11px] text-dim">{formatUpdatedAgo(provider.updated_at, now)}</p>
          </div>
        </div>
        {provider.status === "error" && (
          <span className="px-1.5 py-0.5 rounded bg-status-err/15 text-status-err text-[10.5px] font-medium shrink-0">
            Error
          </span>
        )}
      </div>

      {provider.error && (
        <p className="text-[12px] text-status-wait leading-snug">{provider.error}</p>
      )}

      {hasBuckets ? (
        <div className="space-y-3 pt-0.5">
          {provider.buckets?.map((b) => (
            <UsageMeterRow
              key={b.id}
              label={b.name}
              sublabel={b.group_description}
              usedPercent={b.used_percent}
              resetsAt={b.resets_at}
              now={now}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-3 pt-0.5">
          {provider.session && (
            <UsageMeterRow
              label={windowLabel(provider.session.window_minutes, "5h")}
              usedPercent={provider.session.used_percent}
              resetsAt={provider.session.resets_at}
              now={now}
            />
          )}
          {provider.weekly && (
            <UsageMeterRow
              label={windowLabel(provider.weekly.window_minutes, "7d")}
              usedPercent={provider.weekly.used_percent}
              resetsAt={provider.weekly.resets_at}
              now={now}
            />
          )}
        </div>
      )}
    </div>
  );
}

export function UsageBody({
  connState,
  snapshot,
  loading,
  error,
  unsupported,
  now,
}: {
  connState: ConnectionState;
  snapshot: UsageSnapshot | null;
  loading: boolean;
  error: string | null;
  unsupported: boolean;
  now: number;
}) {
  if (connState !== "connected") {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-4 text-center text-muted">
        <Gauge className="w-6 h-6 text-dim mb-2" />
        <p className="text-[13.5px] font-medium text-fg-soft">Computer not connected</p>
        <p className="text-[12px] text-dim mt-1">
          Connect to a gateway to inspect live model &amp; provider quota.
        </p>
      </div>
    );
  }

  if (unsupported) {
    return (
      <div className="rounded-xl bg-sidebar border border-status-wait/30 p-3.5 text-[12.5px] text-status-wait leading-relaxed">
        The gateway on this computer does not support <code>mobile.usage.get</code> yet. Rebuild or
        update <code>cmob</code> on that Mac to enable live quota tracking.
      </div>
    );
  }

  if (loading && !snapshot) {
    return (
      <div className="flex flex-col items-center justify-center py-14 text-muted gap-2">
        <Loader2 className="w-4 h-4 animate-spin text-muted" />
        <span className="text-[12.5px]">Checking Antigravity, Claude &amp; Codex quota…</span>
      </div>
    );
  }

  if (error && !snapshot) {
    return (
      <div className="rounded-xl bg-status-err/10 border border-status-err/25 p-3.5 text-[12.5px] text-status-err">
        {error}
      </div>
    );
  }

  const providers = snapshot?.providers ?? [];
  if (providers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-4 text-center text-muted">
        <Gauge className="w-6 h-6 text-dim mb-2" />
        <p className="text-[13.5px] font-medium text-fg-soft">No provider quota detected</p>
        <p className="text-[12px] text-dim mt-1 max-w-xs">
          Sign into Antigravity (<code>agy</code>), Claude Code, or Codex on your Mac to see
          real-time limits here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-lg bg-status-wait/10 border border-status-wait/25 px-3 py-2 text-[12px] text-status-wait">
          {error}
        </div>
      )}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3.5 items-start">
        {providers.map((p) => (
          <ProviderUsageCard key={p.provider} provider={p} now={now} />
        ))}
      </div>
    </div>
  );
}

export function UsageView({
  hostName,
  connState,
  snapshot,
  loading,
  refreshing,
  error,
  unsupported,
  now,
  hideHeader = false,
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
  hideHeader?: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="flex flex-col h-full w-full max-w-4xl mx-auto bg-bg text-fg">
      {!hideHeader && (
        <header className="flex items-center justify-between px-4 h-[40px] bg-bg border-b border-line shrink-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <h1 className="text-[13.5px] font-semibold tracking-tight text-fg">Usage</h1>
            <p className="text-[11.5px] text-dim truncate">
              {hostName}
              {snapshot ? ` · ${formatUpdatedAgo(snapshot.updated_at, now)}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={connState !== "connected" || refreshing || loading}
            className="w-7 h-7 rounded-[6px] hover:bg-raised active:opacity-75 text-muted hover:text-fg flex items-center justify-center transition-colors disabled:opacity-40"
            title="Refresh usage"
            aria-label="Refresh usage"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing || loading ? "animate-spin" : ""}`} />
          </button>
        </header>
      )}

      <div className="flex-1 overflow-y-auto scrollbar-sleek px-4 lg:px-8 py-5 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] select-text">
        {hideHeader && (
          <div className="flex items-center justify-between mb-4">
            <div className="text-[12px] text-muted">
              {hostName}
              {snapshot ? ` · ${formatUpdatedAgo(snapshot.updated_at, now)}` : ""}
            </div>
            <button
              type="button"
              onClick={onRefresh}
              disabled={connState !== "connected" || refreshing || loading}
              className="h-7 px-2.5 rounded-md bg-sidebar hover:bg-raised border border-line text-[12px] text-fg-soft inline-flex items-center gap-1.5 transition-colors disabled:opacity-40"
            >
              <RefreshCw className={`w-3 h-3 ${refreshing || loading ? "animate-spin" : ""}`} />
              <span>Refresh</span>
            </button>
          </div>
        )}
        <UsageBody
          connState={connState}
          snapshot={snapshot}
          loading={loading}
          error={error}
          unsupported={unsupported}
          now={now}
        />
      </div>
    </div>
  );
}
