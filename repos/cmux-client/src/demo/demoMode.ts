/**
 * Interactive Demo Controller
 * Intercepts JSON-RPC calls when ?demo=1 is present in the URL or demo mode is enabled.
 * Emulates live agent turn progression, permissions, terminal replay, and device switching.
 */

import {
  DEMO_WORKSPACES_MACBOOK,
  DEMO_WORKSPACES_STUDIO,
  DEMO_CLAUDE_TURNS_INITIAL,
  DEMO_CLAUDE_TURNS_APPROVED,
  DEMO_AGY_TURNS,
  DEMO_RENDER_GRID,
  isDemoMode,
  setDemoMode,
} from "./demoData";
import { RPC_EVENTS, RPC_METHODS, type TerminalReplayPayload } from "../protocol/rpc";
import { getActiveHostId } from "../hosts/hostStore";

export { isDemoMode, setDemoMode };

let claudeApproved = false;

export function resetDemoState(): void {
  claudeApproved = false;
}

export async function handleDemoRpc<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
  eventEmitter?: (event: string, data: unknown) => void,
): Promise<T> {
  const activeHostId = typeof localStorage !== "undefined" ? getActiveHostId(localStorage) : null;
  const isStudio = activeHostId === "mock-mac-studio";

  switch (method) {
    case RPC_METHODS.WORKSPACE_TREE:
    case RPC_METHODS.WORKSPACE_LIST: {
      const workspaces = isStudio ? DEMO_WORKSPACES_STUDIO : DEMO_WORKSPACES_MACBOOK;
      return { workspaces } as T;
    }

    case RPC_METHODS.CHAT_READ_SESSION:
    case RPC_METHODS.CHAT_SUBSCRIBE: {
      const surfaceId = (params?.surface_id as string) || "";
      const isClaude = surfaceId.includes("claude") || (!surfaceId.includes("agy") && !isStudio);
      const isAgy = surfaceId.includes("agy");

      let snap: Record<string, unknown>;
      if (isAgy) {
        snap = {
          turns: DEMO_AGY_TURNS,
          agent_kind: "antigravity",
          is_working: true,
          surface_id: surfaceId,
        };
      } else if (isClaude) {
        snap = {
          turns: claudeApproved ? DEMO_CLAUDE_TURNS_APPROVED : DEMO_CLAUDE_TURNS_INITIAL,
          agent_kind: "claude",
          is_working: !claudeApproved,
          awaiting_prompt: claudeApproved
            ? null
            : "Allow Claude to execute bash command: npm run test?",
          surface_id: surfaceId,
        };
      } else {
        snap = {
          turns: [
            {
              id: "demo-standby-1",
              surface_id: surfaceId,
              role: "assistant",
              events: [
                {
                  kind: "assistant",
                  text: "Agent ready and standing by in cmux workspace.",
                },
              ],
            },
          ],
          agent_kind: "codex",
          is_working: false,
          surface_id: surfaceId,
        };
      }

      if (method === RPC_METHODS.CHAT_SUBSCRIBE && eventEmitter) {
        queueMicrotask(() => {
          eventEmitter(RPC_EVENTS.CHAT_UPDATE, snap);
        });
      }

      return snap as T;
    }

    case RPC_METHODS.CHAT_APPROVE: {
      claudeApproved = true;
      // Dispatch live update event back to listeners
      if (eventEmitter) {
        setTimeout(() => {
          eventEmitter(RPC_EVENTS.CHAT_UPDATE, {
            turns: DEMO_CLAUDE_TURNS_APPROVED,
            agent_kind: "claude",
            is_working: false,
            awaiting_prompt: null,
            surface_id: "surf-claude",
          });
        }, 300);
      }
      return { ok: true } as T;
    }

    case RPC_METHODS.CHAT_SEND: {
      const text = (params?.text as string) || "";
      if (eventEmitter) {
        setTimeout(() => {
          eventEmitter(RPC_EVENTS.CHAT_UPDATE, {
            turns: [
              ...DEMO_CLAUDE_TURNS_APPROVED,
              {
                role: "user",
                events: [{ kind: "user", text }],
              },
              {
                role: "assistant",
                events: [
                  {
                    kind: "assistant",
                    text: `Received prompt: "${text}". Running simulated task on ${isStudio ? "Mac Studio" : "MacBook Pro"}...`,
                  },
                ],
              },
            ],
            agent_kind: "claude",
            is_working: false,
            surface_id: params?.surface_id,
          });
        }, 500);
      }
      return { ok: true } as T;
    }

    case RPC_METHODS.TERMINAL_REPLAY: {
      const payload: TerminalReplayPayload = {
        surface_id: (params?.surface_id as string) || "surf-term",
        columns: 80,
        rows: 24,
        mode: "mobile",
        render_grid: DEMO_RENDER_GRID,
      };
      return payload as T;
    }

    case RPC_METHODS.TERMINAL_INPUT:
    case RPC_METHODS.TERMINAL_PASTE:
    case RPC_METHODS.TERMINAL_SCROLL:
    case RPC_METHODS.TERMINAL_VIEWPORT:
    case RPC_METHODS.TERMINAL_SUBSCRIBE:
    case RPC_METHODS.TERMINAL_UNSUBSCRIBE:
    case RPC_METHODS.CLIENT_VIEWING:
    case RPC_METHODS.CHAT_UNSUBSCRIBE:
      return { ok: true } as T;

    case RPC_METHODS.DEVICE_LIST:
      return {
        devices: [
          {
            device_id: "demo-iphone",
            label: "iPhone 15 Pro · Safari (Current)",
            created_at: Math.floor(Date.now() / 1000) - 3600,
            last_seen_secs: 5,
            current: true,
          },
          {
            device_id: "demo-ipad",
            label: "iPad Pro · Safari",
            created_at: Math.floor(Date.now() / 1000) - 86400,
            last_seen_secs: 1420,
            current: false,
          },
        ],
      } as T;

    case RPC_METHODS.DEVICE_REVOKE:
      return { ok: true } as T;

    case RPC_METHODS.HOST_STATUS:
      return {
        status: "ok",
        version: "0.1.5",
        host_name: isStudio ? "Mac Studio" : "MacBook Pro",
      } as T;

    case RPC_METHODS.PUSH_VAPID_KEY:
      return {
        public_key:
          "BNcRnP-DPh0p7lP1gL4vjW0p6b_4V6kHqF1yU-qG9mE4sR8zT0wK2jL6xP9nQ5oB8yV1tW4rM7eI0lK3uO2aZ4=",
      } as T;

    case RPC_METHODS.PUSH_PREFERENCES:
      return {
        enabled: true,
        alert_on_permission: true,
        alert_on_done: true,
        alert_on_error: true,
      } as T;

    case RPC_METHODS.GIT_STATUS:
      return {
        status: {
          branch: "master",
          ahead: 1,
          behind: 0,
          files: [
            { path: "src/App.tsx", index: "M", worktree: " " },
            { path: "src/components/desktop/DesktopSidebar.tsx", index: "?", worktree: "?" },
          ],
        },
      } as T;

    case RPC_METHODS.GIT_DIFF: {
      const path = typeof params?.path === "string" ? params.path : "src/App.tsx";
      return {
        diff: [
          `diff --git a/${path} b/${path}`,
          `--- a/${path}`,
          `+++ b/${path}`,
          "@@ -1,4 +1,6 @@",
          " export function App() {",
          "-  return <MobileLayout />;",
          "+  const isDesktop = useIsDesktop();",
          "+  return isDesktop ? <DesktopShell /> : <MobileLayout />;",
          " }",
        ].join("\n"),
        truncated: false,
      } as T;
    }

    case RPC_METHODS.FILE_READ: {
      const raw = params?.path;
      const name = typeof raw === "string" ? raw : "PLAN.md";
      return {
        path: name,
        name: name.split("/").pop() ?? name,
        size: 120,
        mtime_ms: 1,
        unchanged: false,
        truncated: false,
        content: `# ${name}\n\nDemo document.\n\n- [x] Parse paths in chat\n- [ ] Open viewer\n\nSee [other.md](other.md).`,
      } as T;
    }

    case RPC_METHODS.USAGE_SPEND: {
      const now = Date.now();
      const zero = {
        cost: 0,
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      };
      const daily = Array.from({ length: 31 }, (_, i) => {
        const d = new Date(now - (30 - i) * 86400_000);
        const cost = 20 + ((i * 37) % 90);
        return {
          date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
          ...zero,
          cost,
          calls: cost * 12,
          input_tokens: cost * 90_000,
          output_tokens: cost * 8_000,
        };
      });
      return {
        status: "ok",
        updated_at: now,
        data: {
          period: "month",
          label: "This month",
          currency: { code: "USD", symbol: "$", rate: 1 },
          sessions: 64,
          cache_hit_percent: 93.5,
          cost: 1480.5,
          calls: 18_200,
          input_tokens: 220_000_000,
          output_tokens: 18_000_000,
          cache_read_tokens: 3_100_000_000,
          cache_write_tokens: 12_000_000,
          today: { ...zero, cost: 62.4, calls: 910 },
          week: { ...zero, cost: 388.2, calls: 5400 },
          month: { ...zero, cost: 1480.5, calls: 18_200 },
          daily,
          models: [
            {
              name: "Sonnet 5.5",
              cost: 720.1,
              calls: 9000,
              input_tokens: 110_000_000,
              output_tokens: 9_000_000,
            },
            {
              name: "Gemini 3.8 Flash",
              cost: 540.3,
              calls: 7000,
              input_tokens: 90_000_000,
              output_tokens: 7_000_000,
            },
            {
              name: "Opus 5.5",
              cost: 220.1,
              calls: 2200,
              input_tokens: 20_000_000,
              output_tokens: 2_000_000,
            },
          ],
          providers: [
            { id: "claude", label: "Claude", cost: 940.2, calls: 11_000, sessions: 40 },
            { id: "antigravity", label: "Antigravity", cost: 540.3, calls: 7200, sessions: 24 },
          ],
          projects: [
            { name: "cmux-mobile", cost: 910.4, sessions: 38 },
            { name: "demo-app", cost: 570.1, sessions: 26 },
          ],
        },
      } as T;
    }

    case RPC_METHODS.USAGE_GET: {
      const now = Date.now();
      return {
        updated_at: now,
        providers: [
          {
            provider: "antigravity",
            display_name: "Antigravity",
            status: "ok",
            session: {
              used_percent: 21,
              window_minutes: 300,
              resets_at: now + 4 * 3600_000 + 53 * 60_000,
            },
            weekly: {
              used_percent: 6,
              window_minutes: 10080,
              resets_at: now + 6 * 86400_000 + 18 * 3600_000,
            },
            buckets: [
              {
                id: "gemini-5h",
                name: "Gemini Models · Five Hour Limit Remaining",
                group: "Gemini Models",
                group_description: "Gemini 4 Hydrogen, Gemini 3.8 Flash",
                window_name: "Five Hour Limit Remaining",
                used_percent: 21,
                window_minutes: 300,
                resets_at: now + 4 * 3600_000 + 53 * 60_000,
              },
              {
                id: "gemini-weekly",
                name: "Gemini Models · Weekly Limit Remaining",
                group: "Gemini Models",
                group_description: "Gemini 4 Hydrogen, Gemini 3.8 Flash",
                window_name: "Weekly Limit Remaining",
                used_percent: 6,
                window_minutes: 10080,
                resets_at: now + 6 * 86400_000 + 18 * 3600_000,
              },
              {
                id: "3p-5h",
                name: "Claude and GPT models · Five Hour Limit Remaining",
                group: "Claude and GPT models",
                group_description: "Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS 120B",
                window_name: "Five Hour Limit Remaining",
                used_percent: 12,
                window_minutes: 300,
                resets_at: now + 3 * 3600_000 + 10 * 60_000,
              },
            ],
            updated_at: now,
          },
          {
            provider: "claude",
            display_name: "Claude Code",
            status: "ok",
            session: {
              used_percent: 64,
              window_minutes: 300,
              resets_at: now + 2 * 3600_000 + 15 * 60_000,
            },
            weekly: {
              used_percent: 38,
              window_minutes: 10080,
              resets_at: now + 4 * 86400_000 + 5 * 3600_000,
            },
            updated_at: now,
          },
          {
            provider: "codex",
            display_name: "Codex",
            status: "ok",
            plan_type: "plus",
            session: {
              used_percent: 14,
              window_minutes: 300,
              resets_at: now + 4 * 3600_000 + 20 * 60_000,
            },
            weekly: {
              used_percent: 82,
              window_minutes: 10080,
              resets_at: now + 1 * 86400_000 + 11 * 3600_000,
            },
            updated_at: now,
          },
        ],
      } as T;
    }

    default:
      return {} as T;
  }
}
