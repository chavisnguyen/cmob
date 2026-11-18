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

      if (isAgy) {
        return {
          turns: DEMO_AGY_TURNS,
          agent_kind: "antigravity",
          is_working: true,
          surface_id: surfaceId,
        } as T;
      }

      if (isClaude) {
        return {
          turns: claudeApproved ? DEMO_CLAUDE_TURNS_APPROVED : DEMO_CLAUDE_TURNS_INITIAL,
          agent_kind: "claude",
          is_working: !claudeApproved,
          awaiting_prompt: claudeApproved
            ? null
            : "Allow Claude to execute bash command: npm run test?",
          surface_id: surfaceId,
        } as T;
      }

      // Default fallback turn
      return {
        turns: [
          {
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
      } as T;
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
          ahead: 0,
          behind: 0,
          staged: [],
          unstaged: [],
          untracked: [],
        },
      } as T;

    default:
      return {} as T;
  }
}
