/**
 * High-fidelity Interactive Demo Fixtures
 * Powers offline demo exploration (?demo=1) and automated screenshot/video recording.
 * Zero-touch: Completely isolated from real cmux sockets or host filesystems.
 */

import type { SavedHost } from "../hosts/hostStore";
import type { WorkspaceNode, RenderGridData } from "../protocol/rpc";
import type { AgentTurn } from "../protocol/event";

export const DEMO_STORAGE_KEY = "cmux_demo";

export function isDemoMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has("demo") || window.location.hash.includes("demo")) return true;
    return localStorage.getItem(DEMO_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setDemoMode(enabled: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (enabled) localStorage.setItem(DEMO_STORAGE_KEY, "1");
    else localStorage.removeItem(DEMO_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export const DEMO_HOSTS: SavedHost[] = [
  {
    id: "mock-macbook-pro",
    name: "MacBook Pro (M3 Max)",
    endpoint: "mock://macbook-pro",
    token: "demo-token-macbook",
  },
  {
    id: "mock-mac-studio",
    name: "Mac Studio (M2 Ultra)",
    endpoint: "mock://mac-studio",
    token: "demo-token-studio",
  },
];

export const DEMO_WORKSPACES_MACBOOK: WorkspaceNode[] = [
  {
    id: "ws-cmob",
    ref: "workspace-1",
    title: "cmux-mobile",
    pinned: true,
    selected: true,
    status: "running",
    current_directory: "~/projects/cmux-mobile",
    color: "#38bdf8",
    snippet: "Allow Claude to execute bash command: npm run test?",
    surfaces: [
      {
        id: "surf-claude",
        ref: "surface-1",
        title: "Claude Code",
        surface_type: "terminal",
        selected: true,
        focused: true,
        agent: {
          session_id: "demo-claude-s1",
          agent_kind: "claude",
          status: "running",
        },
      },
      {
        id: "surf-term",
        ref: "surface-2",
        title: "zsh · git",
        surface_type: "terminal",
        selected: false,
        focused: false,
      },
    ],
  },
  {
    id: "ws-ai",
    ref: "workspace-2",
    title: "ai-workflows",
    pinned: true,
    selected: false,
    status: "running",
    current_directory: "~/projects/ai-workflows",
    color: "#a855f7",
    snippet: "Antigravity reasoning: coordinating 3 audit subagents...",
    surfaces: [
      {
        id: "surf-agy",
        ref: "surface-3",
        title: "Antigravity",
        surface_type: "terminal",
        selected: true,
        focused: true,
        agent: {
          session_id: "demo-agy-s1",
          agent_kind: "antigravity",
          status: "running",
        },
      },
    ],
  },
  {
    id: "ws-gateway",
    ref: "workspace-3",
    title: "gateway-core",
    pinned: false,
    selected: false,
    status: "idle",
    current_directory: "~/projects/cmux-gateway",
    color: "#22c55e",
    snippet: "Daemon running · 149/149 Rust tests passing",
    surfaces: [
      {
        id: "surf-cargo",
        ref: "surface-4",
        title: "cargo test",
        surface_type: "terminal",
        selected: true,
        focused: false,
      },
    ],
  },
];

export const DEMO_WORKSPACES_STUDIO: WorkspaceNode[] = [
  {
    id: "ws-mesh",
    ref: "workspace-s1",
    title: "distributed-mesh",
    pinned: true,
    selected: true,
    status: "running",
    current_directory: "~/dev/distributed-mesh",
    color: "#f59e0b",
    snippet: "Codex orchestrating model checkpoint evaluation...",
    surfaces: [
      {
        id: "surf-codex",
        ref: "surface-s1",
        title: "Codex Engine",
        surface_type: "terminal",
        selected: true,
        focused: true,
        agent: {
          session_id: "demo-codex-s1",
          agent_kind: "codex",
          status: "running",
        },
      },
    ],
  },
  {
    id: "ws-eval",
    ref: "workspace-s2",
    title: "eval-benchmarks",
    pinned: false,
    selected: false,
    status: "idle",
    current_directory: "~/dev/eval-benchmarks",
    color: "#ec4899",
    snippet: "Kiro benchmark turn finished (48/48 passed)",
    surfaces: [
      {
        id: "surf-kiro",
        ref: "surface-s2",
        title: "Kiro",
        surface_type: "terminal",
        selected: true,
        focused: true,
        agent: {
          session_id: "demo-kiro-s1",
          agent_kind: "kiro",
          status: "idle",
        },
      },
    ],
  },
];

export const DEMO_CLAUDE_TURNS_INITIAL: AgentTurn[] = [
  {
    id: "turn-claude-1",
    surface_id: "surf-claude",
    role: "user",
    events: [
      {
        kind: "user",
        text: "Add multi-device switching tabs to the mobile companion and verify with tests.",
      },
    ],
  },
  {
    id: "turn-claude-2",
    surface_id: "surf-claude",
    role: "assistant",
    events: [
      {
        kind: "thinking",
        text: "I will inspect `useHosts.ts` and `DeviceTabStrip.tsx`, then wire up the top bar so users can tap to switch between MacBook and Mac Studio. Then I'll run the client test suite.",
      },
      {
        kind: "tool-start",
        tool_id: "t1",
        name: "edit_file",
        detail: "repos/cmux-client/src/components/hosts/DeviceTabStrip.tsx",
      },
      {
        kind: "tool-end",
        tool_id: "t1",
        name: "edit_file",
        detail: "Added 1-tap switching and status dots",
        ok: true,
      },
      {
        kind: "assistant",
        text: "I have updated `DeviceTabStrip.tsx` with live indicator dots and 1-tap machine switching. Before completing the turn, I need permission to run tests.",
      },
      {
        kind: "awaiting-input",
        input_kind: "permission",
        prompt: "Allow Claude to execute bash command: npm run test in repos/cmux-client?",
        options: ["Approve", "Deny"],
        default_choice: "Approve",
      },
    ],
  },
];

export const DEMO_CLAUDE_TURNS_APPROVED: AgentTurn[] = [
  ...DEMO_CLAUDE_TURNS_INITIAL.slice(0, 1),
  {
    id: "turn-claude-2",
    surface_id: "surf-claude",
    role: "assistant",
    events: [
      {
        kind: "thinking",
        text: "I will inspect `useHosts.ts` and `DeviceTabStrip.tsx`, then wire up the top bar so users can tap to switch between MacBook and Mac Studio.",
      },
      {
        kind: "tool-start",
        tool_id: "t1",
        name: "edit_file",
        detail: "repos/cmux-client/src/components/hosts/DeviceTabStrip.tsx",
      },
      {
        kind: "tool-end",
        tool_id: "t1",
        name: "edit_file",
        detail: "Added 1-tap switching and status dots",
        ok: true,
      },
      {
        kind: "tool-start",
        tool_id: "t2",
        name: "run_command",
        detail: "npm run test",
      },
      {
        kind: "tool-end",
        tool_id: "t2",
        name: "run_command",
        detail: "21 passed (112 tests)",
        ok: true,
      },
      {
        kind: "assistant",
        text: "✓ Permission granted. Executed `npm run test` successfully!\n\nAll **112 client tests** and **149 gateway tests** passed with 0 errors. Multi-device tab switching is verified.",
      },
      {
        kind: "usage",
        model: "claude-3-7-sonnet",
        input_tokens: 3412,
        output_tokens: 618,
      },
    ],
  },
];

export const DEMO_AGY_TURNS: AgentTurn[] = [
  {
    id: "turn-agy-1",
    surface_id: "surf-agy",
    role: "user",
    events: [
      {
        kind: "user",
        text: "Coordinate a multi-perspective protocol audit against `protocol_spec.md`.",
      },
    ],
  },
  {
    id: "turn-agy-2",
    surface_id: "surf-agy",
    role: "assistant",
    events: [
      {
        kind: "thinking",
        text: "Spawning 3 clean-context subagents to verify wire-protocol frames, DNS rebinding guards, and mobile touch event handlers.",
      },
      {
        kind: "subagents",
        group_id: "audit-swarm",
        agents: [
          {
            id: "sub-1",
            label: "Protocol Auditor",
            state: "completed",
            tokens: 1840,
          },
          {
            id: "sub-2",
            label: "Security Isolation Auditor",
            state: "working",
            tokens: 2450,
          },
          {
            id: "sub-3",
            label: "UX Flow Verifier",
            state: "working",
            tokens: 920,
          },
        ],
      },
      {
        kind: "assistant",
        text: "Independent subagent audit underway:\n- **Protocol Auditor**: Verified 14 RPC methods and RFC 8292 VAPID headers.\n- **Security Isolation**: Cross-checking CORS origin filters against `chavisnguyen.github.io`.\n- **UX Flow**: Validating tactile touch targets and mobile key row.",
      },
    ],
  },
];

export const DEMO_RENDER_GRID: RenderGridData = {
  active_screen: "primary",
  columns: 80,
  rows: 24,
  styles: [
    { id: 0 },
    { id: 1, foreground: "#38bdf8", bold: true }, // cyan bold
    { id: 2, foreground: "#22c55e", bold: true }, // green bold
    { id: 3, foreground: "#94a3b8" }, // slate
    { id: 4, foreground: "#e2e8f0" }, // white
    { id: 5, foreground: "#f59e0b" }, // amber
  ],
  row_spans: [
    { row: 0, column: 0, style_id: 1, text: "➜  cmux-mobile (master) " },
    { row: 0, column: 25, style_id: 4, text: "$ cmob status" },
    {
      row: 1,
      column: 0,
      style_id: 3,
      text: "------------------------------------------------------------",
    },
    { row: 2, column: 0, style_id: 4, text: "Gateway     " },
    { row: 2, column: 12, style_id: 2, text: "✓ running on 127.0.0.1:8088 (v0.1.5)" },
    { row: 3, column: 0, style_id: 4, text: "cmux        " },
    { row: 3, column: 12, style_id: 2, text: "✓ connected" },
    { row: 4, column: 0, style_id: 4, text: "Autostart   " },
    { row: 4, column: 12, style_id: 2, text: "✓ installed (~/.zshrc)" },
    { row: 5, column: 0, style_id: 4, text: "Tailscale   " },
    { row: 5, column: 12, style_id: 1, text: "✓ https://macbook-pro.tailnet.ts.net" },
    { row: 6, column: 0, style_id: 4, text: "Connected   " },
    { row: 6, column: 12, style_id: 4, text: "1 client (iPhone 15 Pro · Safari)" },
    { row: 7, column: 0, style_id: 4, text: "Paired      " },
    { row: 7, column: 12, style_id: 4, text: "2 devices (cmob devices)" },
    {
      row: 8,
      column: 0,
      style_id: 3,
      text: "------------------------------------------------------------",
    },
    { row: 9, column: 0, style_id: 1, text: "➜  cmux-mobile (master) " },
    { row: 9, column: 25, style_id: 4, text: "$ git status" },
    { row: 10, column: 0, style_id: 4, text: "On branch master" },
    { row: 11, column: 0, style_id: 2, text: "Your branch is up to date with 'origin/master'." },
    { row: 12, column: 0, style_id: 4, text: "nothing to commit, working tree clean" },
    { row: 13, column: 0, style_id: 1, text: "➜  cmux-mobile (master) " },
    { row: 13, column: 25, style_id: 3, text: "█" },
  ],
  cursor: {
    column: 26,
    row: 13,
    visible: true,
    style: "block",
  },
};
