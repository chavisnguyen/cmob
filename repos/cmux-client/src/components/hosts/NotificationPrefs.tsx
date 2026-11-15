import { useEffect, useState } from "react";
import { pushManager } from "../../notifications/pushManager";
import { RPC_METHODS } from "../../protocol/rpc";
import { wsClient } from "../../transport/wsClient";

/** Gateway categories (`PUSH_CATEGORIES` in push.rs) with labels. */
export const PUSH_CATEGORY_LABELS: Record<string, string> = {
  "needs-permission": "Agent needs approval",
  "turn-finished": "Agent finished a turn",
  "cmux-dialog": "Agent shows a startup dialog",
};

/** Adds or removes `category` from the muted list; returns a new sorted list. */
export function toggleMuted(
  muted: readonly string[],
  category: string,
  enabled: boolean,
): string[] {
  const set = new Set(muted);
  if (enabled) set.delete(category);
  else set.add(category);
  return [...set].sort();
}

interface PrefsResponse {
  categories: string[];
  muted_categories: string[];
}

/** Per-category notification opt-outs for this browser's push subscription. */
export function NotificationPrefs() {
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [muted, setMuted] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ep = await pushManager.getEndpoint();
      if (cancelled || !ep || wsClient.getState() !== "connected") return;
      try {
        const resp = await wsClient.call<PrefsResponse>(RPC_METHODS.PUSH_PREFERENCES, {
          endpoint: ep,
        });
        if (cancelled) return;
        setEndpoint(ep);
        setCategories(resp.categories);
        setMuted(resp.muted_categories);
      } catch {
        // not registered with this host yet: section stays hidden
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!endpoint) return null;

  const change = async (category: string, enabled: boolean) => {
    const next = toggleMuted(muted, category, enabled);
    setMuted(next); // optimistic
    setError(null);
    try {
      const resp = await wsClient.call<PrefsResponse>(RPC_METHODS.PUSH_PREFERENCES, {
        endpoint,
        muted_categories: next,
      });
      setMuted(resp.muted_categories);
    } catch {
      setMuted(muted);
      setError("Could not save the preference.");
    }
  };

  return (
    <section className="space-y-2">
      <h3 className="text-[13px] font-semibold text-[#d4d4d4]">Notify me when</h3>
      {categories.map((c) => (
        <label
          key={c}
          className="flex items-center justify-between gap-3 rounded-xl bg-[#0a0a0a] border border-white/[0.1] px-3 py-2.5 text-[13.5px]"
        >
          <span>{PUSH_CATEGORY_LABELS[c] ?? c}</span>
          <input
            type="checkbox"
            checked={!muted.includes(c)}
            onChange={(e) => void change(c, e.target.checked)}
            className="w-5 h-5 accent-[#3276f2]"
          />
        </label>
      ))}
      {error && <p className="text-[12.5px] text-rose-400">{error}</p>}
    </section>
  );
}
