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
  emerald: "bg-emerald-400",
  amber: "bg-amber-400",
  rose: "bg-rose-400",
};

const TEXT_CLASS: Record<UsageTone, string> = {
  emerald: "text-emerald-300",
  amber: "text-amber-300",
  rose: "text-rose-300",
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
        <span className={`text-[12.5px] font-mono font-semibold shrink-0 ${TEXT_CLASS[tone]}`}>
          {used}%
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-raised overflow-hidden">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ease-out ${BAR_CLASS[tone]}`}
          style={{ width: `${used}%` }}
        />
      </div>
      {resetText && <div className="text-[11px] text-dim">{resetText}</div>}
    </div>
  );
}

function ProviderUsageCard({ provider, now }: { provider: ProviderUsage; now: number }) {
  const hasBuckets = Boolean(provider.buckets && provider.buckets.length > 0);

  return (
    <div className="rounded-2xl bg-surface border border-white/[0.08] p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-xl bg-bg border border-white/[0.08] flex items-center justify-center shrink-0">
            <AgentIcon kind={provider.provider} size={18} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-[14.5px] font-semibold text-fg truncate">
                {provider.display_name}
              </h2>
              {provider.plan_type && (
                <span className="px-1.5 py-0.5 rounded-md bg-raised text-[10.5px] font-semibold uppercase tracking-wider text-muted">
                  {provider.plan_type}
                </span>
              )}
            </div>
            <p className="text-[11px] text-dim">{formatUpdatedAgo(provider.updated_at, now)}</p>
          </div>
        </div>
        {provider.status === "error" && (
          <span className="px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300 text-[11px] font-medium shrink-0">
            Error
          </span>
        )}
      </div>

      {provider.error && (
        <p className="text-[12px] text-amber-300 leading-snug">{provider.error}</p>
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
        <Gauge className="w-7 h-7 text-dim mb-2.5" />
        <p className="text-[14px] font-medium text-fg-soft">Computer not connected</p>
        <p className="text-[12.5px] text-dim mt-1">
          Connect to a gateway to inspect live model &amp; provider quota.
        </p>
      </div>
    );
  }

  if (unsupported) {
    return (
      <div className="rounded-2xl bg-surface border border-amber-500/25 p-4 text-[13px] text-amber-200 leading-relaxed">
        The gateway on this computer does not support <code>mobile.usage.get</code> yet. Rebuild or
        update <code>cmob</code> on that Mac to enable live quota tracking.
      </div>
    );
  }

  if (loading && !snapshot) {
    return (
      <div className="flex flex-col items-center justify-center py-14 text-muted gap-2.5">
        <Loader2 className="w-5 h-5 animate-spin text-accent-soft" />
        <span className="text-[13px]">Checking Antigravity, Claude &amp; Codex quota…</span>
      </div>
    );
  }

  if (error && !snapshot) {
    return (
      <div className="rounded-2xl bg-rose-500/10 border border-rose-500/25 p-4 text-[13px] text-rose-300">
        {error}
      </div>
    );
  }

  const providers = snapshot?.providers ?? [];
  if (providers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-4 text-center text-muted">
        <Gauge className="w-7 h-7 text-dim mb-2.5" />
        <p className="text-[14px] font-medium text-fg-soft">No provider quota detected</p>
        <p className="text-[12.5px] text-dim mt-1 max-w-xs">
          Sign into Antigravity (<code>agy</code>), Claude Code, or Codex on your Mac to see
          real-time limits here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-xl bg-amber-500/10 border border-amber-500/25 px-3 py-2 text-[12px] text-amber-200">
          {error}
        </div>
      )}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
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
  return (
    <div className="flex flex-col h-full w-full max-w-3xl lg:max-w-none mx-auto bg-bg text-fg">
      <header className="flex items-center justify-between px-4 lg:px-8 min-h-[48px] bg-bg border-b border-white/[0.06] shrink-0">
        <div className="min-w-0">
          <h1 className="text-[15.5px] font-semibold tracking-tight text-fg">Usage</h1>
          <p className="text-[11.5px] text-muted truncate">
            {hostName}
            {snapshot ? ` · ${formatUpdatedAgo(snapshot.updated_at, now)}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={connState !== "connected" || refreshing || loading}
          className="w-8 h-8 rounded-lg hover:bg-white/[0.06] active:opacity-75 text-muted hover:text-fg flex items-center justify-center transition-colors disabled:opacity-40"
          title="Refresh usage"
          aria-label="Refresh usage"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing || loading ? "animate-spin" : ""}`} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto scrollbar-sleek px-4 lg:px-8 py-5 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] select-text">
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
