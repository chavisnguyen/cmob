/* eslint-disable react-refresh/only-export-components */
import { useEffect, useState, type ReactElement } from "react";
import {
  loadLocalNotificationPrefs,
  saveLocalNotificationPrefs,
  subscribeLocalNotificationPrefs,
  type LocalNotificationPrefs,
} from "../../notifications/localPrefs";
import { pushManager } from "../../notifications/pushManager";
import { RPC_METHODS } from "../../protocol/rpc";
import { wsClient } from "../../transport/wsClient";
import { haptic } from "../../native/haptics";

/** Gateway categories (`PUSH_CATEGORIES` in push.rs) with labels. */
export const PUSH_CATEGORY_LABELS: Record<string, string> = {
  "needs-permission": "Agent needs approval",
  "turn-finished": "Agent finished a turn",
  "agent-error": "Agent encountered an error",
  "cmux-dialog": "Agent shows a startup dialog",
};

export const PUSH_CATEGORY_DESCRIPTIONS: Record<string, string> = {
  "needs-permission": "Alert when an agent is waiting for tool or terminal approval",
  "turn-finished": "Alert when an autonomous agent completes its response",
  "agent-error": "Alert when a session command fails or exits with an error",
  "cmux-dialog": "Alert when a cmux modal dialog opens requiring interaction",
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
export function NotificationPrefs(): ReactElement {
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [muted, setMuted] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [localPrefs, setLocalPrefs] = useState<LocalNotificationPrefs>(() =>
    loadLocalNotificationPrefs(),
  );

  useEffect(() => {
    return subscribeLocalNotificationPrefs(setLocalPrefs);
  }, []);

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
    haptic("light");
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
    haptic("light");
    const next = { ...localPrefs, [key]: value };
    setLocalPrefs(next);
    saveLocalNotificationPrefs(next);
  };

  return (
    <div className="space-y-5">
      {endpoint && (
        <section className="space-y-2">
          <h3 className="text-[12.5px] font-semibold uppercase tracking-wider text-[#71717a]">
            Push Notification Categories
          </h3>
          <div className="space-y-2">
            {categories.map((c) => (
              <label
                key={c}
                className="flex items-center justify-between gap-3 min-h-[44px] rounded-xl bg-[#16161b] hover:bg-white/[0.04] border border-white/[0.08] px-3.5 py-2.5 transition-colors cursor-pointer"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium text-[#fafafa]">
                    {PUSH_CATEGORY_LABELS[c] ?? c}
                  </div>
                  {PUSH_CATEGORY_DESCRIPTIONS[c] && (
                    <div className="text-[11.5px] text-[#71717a] mt-0.5">
                      {PUSH_CATEGORY_DESCRIPTIONS[c]}
                    </div>
                  )}
                </div>
                <input
                  type="checkbox"
                  checked={!muted.includes(c)}
                  onChange={(e) => void changePushCategory(c, e.target.checked)}
                  className="w-5 h-5 rounded accent-[#3276f2] cursor-pointer shrink-0"
                />
              </label>
            ))}
          </div>
          {error && <p className="text-[12px] text-rose-400">{error}</p>}
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-[12.5px] font-semibold uppercase tracking-wider text-[#71717a]">
          In-App &amp; Browser Alerts
        </h3>
        <div className="space-y-2">
          {[
            {
              key: "inAppToast" as const,
              label: "In-App Toast Banners",
              desc: "Show floating alert banners inside the app when agents need attention",
            },
            {
              key: "desktopBrowserNotif" as const,
              label: "Browser Alerts When Hidden",
              desc: "Show system browser notification when this tab is in the background",
            },
            {
              key: "suppressWhileViewing" as const,
              label: "Silence Active Session Alerts",
              desc: "Mute alerts for the terminal surface currently displayed on screen",
            },
          ].map(({ key, label, desc }) => (
            <label
              key={key}
              className="flex items-center justify-between gap-3 min-h-[44px] rounded-xl bg-[#16161b] hover:bg-white/[0.04] border border-white/[0.08] px-3.5 py-2.5 transition-colors cursor-pointer"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium text-[#fafafa]">{label}</div>
                <div className="text-[11.5px] text-[#71717a] mt-0.5">{desc}</div>
              </div>
              <input
                type="checkbox"
                checked={localPrefs[key]}
                onChange={(e) => updateLocalPref(key, e.target.checked)}
                className="w-5 h-5 rounded accent-[#3276f2] cursor-pointer shrink-0"
              />
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}
