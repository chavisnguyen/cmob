import { useEffect, useState } from "react";
import {
  loadLocalNotificationPrefs,
  saveLocalNotificationPrefs,
  type LocalNotificationPrefs,
} from "../../notifications/localPrefs";
import { pushManager } from "../../notifications/pushManager";
import { RPC_METHODS } from "../../protocol/rpc";
import { wsClient } from "../../transport/wsClient";

/** Gateway categories (`PUSH_CATEGORIES` in push.rs) with labels. */
export const PUSH_CATEGORY_LABELS: Record<string, string> = {
  "needs-permission": "Agent needs approval",
  "turn-finished": "Agent finished a turn",
  "agent-error": "Agent encountered an error",
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

/** Per-category Web Push opt-outs and local in-app/browser notification toggles. */
export function NotificationPrefs() {
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [muted, setMuted] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [localPrefs, setLocalPrefs] = useState<LocalNotificationPrefs>(() =>
    loadLocalNotificationPrefs(),
  );

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
        // not registered with this host yet: push section stays hidden
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const changePushCategory = async (category: string, enabled: boolean) => {
    if (!endpoint) return;
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

  const updateLocalPref = (key: keyof LocalNotificationPrefs, value: boolean) => {
    const next = { ...localPrefs, [key]: value };
    setLocalPrefs(next);
    saveLocalNotificationPrefs(next);
  };

  return (
    <div className="space-y-4">
      {endpoint && (
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
                onChange={(e) => void changePushCategory(c, e.target.checked)}
                className="w-5 h-5 accent-[#3276f2]"
              />
            </label>
          ))}
          {error && <p className="text-[12.5px] text-rose-400">{error}</p>}
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-[13px] font-semibold text-[#d4d4d4]">In-app &amp; browser alerts</h3>
        {(
          [
            ["inAppToast", "Show in-app toast banner"],
            ["desktopBrowserNotif", "Browser notification when tab is hidden"],
            ["suppressWhileViewing", "Silence alerts for the session I am viewing"],
          ] as const
        ).map(([key, label]) => (
          <label
            key={key}
            className="flex items-center justify-between gap-3 rounded-xl bg-[#0a0a0a] border border-white/[0.1] px-3 py-2.5 text-[13.5px]"
          >
            <span>{label}</span>
            <input
              type="checkbox"
              checked={localPrefs[key]}
              onChange={(e) => updateLocalPref(key, e.target.checked)}
              className="w-5 h-5 accent-[#3276f2]"
            />
          </label>
        ))}
      </section>
    </div>
  );
}
