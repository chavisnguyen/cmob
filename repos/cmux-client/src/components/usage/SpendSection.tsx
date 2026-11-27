import { useMemo, useState } from "react";
import { Flame, Loader2, RefreshCw } from "lucide-react";
import type { SpendData, SpendPeriod } from "../../protocol/rpc";
import type { ConnectionState } from "../../transport/wsClient";
import {
  barPercent,
  dailyForPeriod,
  formatCost,
  formatTokens,
  SPEND_PERIODS,
} from "./spendFormatting";
import { useSpendSnapshot } from "./useSpendSnapshot";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-surface border border-line px-3 py-2 min-w-0">
      <div className="text-[10.5px] uppercase tracking-wider text-dim">{label}</div>
      <div className="text-[15px] font-semibold font-mono tabular-nums text-fg truncate">{value}</div>
      {sub && <div className="text-[11px] text-dim font-mono truncate">{sub}</div>}
    </div>
  );
}

function RankList({
  title,
  rows,
}: {
  title: string;
  rows: { key: string; name: string; cost: string; sub: string; pct: number }[];
}) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-[11px] uppercase tracking-wider text-dim">{title}</h3>
      {rows.map((r) => (
        <div key={r.key} className="space-y-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[12.5px] text-fg-soft truncate">{r.name}</span>
            <span className="text-[12px] font-mono tabular-nums text-fg shrink-0">{r.cost}</span>
          </div>
          <div className="h-1 w-full rounded-full bg-raised overflow-hidden">
            <div className="h-full rounded-full bg-status-wait" style={{ width: `${r.pct}%` }} />
          </div>
          <div className="text-[11px] text-dim font-mono">{r.sub}</div>
        </div>
      ))}
    </div>
  );
}

function DailyBars({
  data,
  period,
  asOf,
}: {
  data: SpendData;
  period: SpendPeriod;
  asOf: number;
}) {
  const days = useMemo(
    () => dailyForPeriod(data.daily, period, new Date(asOf)),
    [data.daily, period, asOf],
  );
  const max = Math.max(0, ...days.map((d) => d.cost));
  if (days.length === 0) return null;
  const sym = data.currency.symbol;
  return (
    <div className="space-y-1.5">
      <h3 className="text-[11px] uppercase tracking-wider text-dim">Daily cost</h3>
      <div className="flex items-end gap-[3px] h-20" role="img" aria-label="Daily cost bar chart">
        {days.map((d) => (
          <div
            key={d.date}
            className="flex-1 min-w-0 rounded-t-[2px] bg-status-wait/80 hover:bg-status-wait"
            style={{ height: `${Math.max(barPercent(d.cost, max), 2)}%` }}
            title={`${d.date} · ${formatCost(sym, d.cost)} · ${formatTokens(d.input_tokens + d.output_tokens)} tokens`}
          />
        ))}
      </div>
      <div className="flex justify-between text-[10.5px] text-dim font-mono">
        <span>{days[0].date.slice(5)}</span>
        <span>{days[days.length - 1].date.slice(5)}</span>
      </div>
    </div>
  );
}

function SpendBody({
  data,
  period,
  asOf,
}: {
  data: SpendData;
  period: SpendPeriod;
  asOf: number;
}) {
  const sym = data.currency.symbol;
  const maxModel = Math.max(0, ...data.models.map((m) => m.cost));
  const maxProvider = Math.max(0, ...data.providers.map((p) => p.cost));
  const maxProject = Math.max(0, ...data.projects.map((p) => p.cost));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label={data.label || "Spend"} value={formatCost(sym, data.cost)} sub={`${data.calls.toLocaleString("en-US")} calls`} />
        <Stat label="Today" value={formatCost(sym, data.today.cost)} sub={`${data.today.calls.toLocaleString("en-US")} calls`} />
        <Stat
          label="Tokens in / out"
          value={`${formatTokens(data.input_tokens)} / ${formatTokens(data.output_tokens)}`}
          sub={`cache ${data.cache_hit_percent.toFixed(0)}% hit`}
        />
        <Stat label="Sessions" value={data.sessions.toLocaleString("en-US")} />
      </div>
      <DailyBars data={data} period={period} asOf={asOf} />
      <RankList
        title="By provider"
        rows={data.providers.map((p) => ({
          key: p.id,
          name: p.label,
          cost: formatCost(sym, p.cost),
          sub: `${p.calls.toLocaleString("en-US")} calls · ${p.sessions} sessions`,
          pct: barPercent(p.cost, maxProvider),
        }))}
      />
      <RankList
        title="By model"
        rows={data.models.map((m) => ({
          key: m.name,
          name: m.name,
          cost: formatCost(sym, m.cost),
          sub: `${formatTokens(m.input_tokens)} in · ${formatTokens(m.output_tokens)} out`,
          pct: barPercent(m.cost, maxModel),
        }))}
      />
      <RankList
        title="By project"
        rows={data.projects.map((p) => ({
          key: p.name,
          name: p.name,
          cost: formatCost(sym, p.cost),
          sub: `${p.sessions} sessions`,
          pct: barPercent(p.cost, maxProject),
        }))}
      />
    </div>
  );
}

/** Day/month token-cost section of the Usage tab, backed by the host's `codeburn` CLI. */
export function SpendSection({
  connState,
  hostKey,
}: {
  connState: ConnectionState;
  hostKey: string;
}) {
  const [period, setPeriod] = useState<SpendPeriod>("month");
  const spend = useSpendSnapshot({ enabled: true, connState, hostKey, period });

  if (connState !== "connected" || spend.unsupported) return null;
  const snap = spend.snapshot;
  // codeburn missing on the host: hide the section instead of nagging.
  if (snap?.status === "unavailable") {
    return (
      <p className="mt-6 text-[11.5px] text-dim">
        Install <code>codeburn</code> on the host (<code>npm i -g codeburn</code>) to see daily and
        monthly spend here.
      </p>
    );
  }

  const busy = spend.loading || spend.refreshing;
  return (
    <section className="mt-6 space-y-3" aria-label="Spend">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[13px] font-semibold text-fg">
          <Flame className="w-3.5 h-3.5 text-status-wait" />
          Spend
        </div>
        <div className="flex items-center gap-1">
          <div className="inline-flex rounded-md bg-sidebar border border-line p-0.5" role="tablist">
            {SPEND_PERIODS.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={period === p.id}
                onClick={() => setPeriod(p.id)}
                className={`px-2 h-6 rounded text-[11.5px] transition-colors ${
                  period === p.id ? "bg-raised text-fg" : "text-muted hover:text-fg"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void spend.refresh()}
            disabled={busy}
            className="w-7 h-7 rounded-md hover:bg-raised text-muted hover:text-fg flex items-center justify-center transition-colors disabled:opacity-40"
            title="Refresh spend"
            aria-label="Refresh spend"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {spend.error && !snap && (
        <div className="rounded-lg bg-status-err/10 border border-status-err/25 px-3 py-2 text-[12px] text-status-err">
          {spend.error}
        </div>
      )}
      {snap?.status === "error" && (
        <div className="rounded-lg bg-status-wait/10 border border-status-wait/25 px-3 py-2 text-[12px] text-status-wait">
          {snap.error ?? "Could not read codeburn."}
        </div>
      )}
      {!snap && spend.loading && (
        <div className="flex items-center justify-center py-8 text-muted gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-[12.5px]">Reading spend…</span>
        </div>
      )}
      {snap?.status === "ok" && snap.data && <SpendBody data={snap.data} period={period} asOf={snap.updated_at} />}
    </section>
  );
}
