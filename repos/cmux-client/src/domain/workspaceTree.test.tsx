import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ChatVirtualizedTimeline } from "../components/chat/ChatVirtualizedTimeline";
import { AgentIcon } from "../components/common/AgentIcon";
import { UnreadCountBadge } from "../components/common/UnreadCountBadge";
import type { WorkspaceNode } from "../protocol/rpc";
import {
  clearSurfaceUnreadInWorkspaces,
  mergeWorkspaces,
  totalUnreadNotifications,
} from "./workspaceTree";

function sampleWorkspaces(): WorkspaceNode[] {
  return [
    {
      id: "ws-1",
      ref: "workspace:1",
      title: "EnglishMaile",
      pinned: true,
      selected: true,
      status: "running",
      current_directory: "/repo/englishmaile",
      unread_count: 2,
      surfaces: [
        {
          id: "surf-a",
          ref: "surface:10",
          title: "Check Current Status",
          surface_type: "terminal",
          selected: true,
          focused: true,
          unread_count: 1,
        },
        {
          id: "surf-b",
          ref: "surface:11",
          title: "Backend Worker",
          surface_type: "terminal",
          selected: false,
          focused: false,
          unread_count: 1,
        },
      ],
    },
  ];
}

describe("unread notification badges and cached syncing UI", () => {
  it("renders high-contrast accent unread count pill and hides when count <= 0", () => {
    expect(renderToStaticMarkup(<UnreadCountBadge count={0} />)).toBe("");
    const badgeHtml = renderToStaticMarkup(<UnreadCountBadge count={1} />);
    expect(badgeHtml).toContain('data-testid="unread-count-badge"');
    expect(badgeHtml).toContain("bg-accent");
    expect(badgeHtml).toContain(">1<");

    const cappedHtml = renderToStaticMarkup(<UnreadCountBadge count={128} />);
    expect(cappedHtml).toContain(">99+<");
  });

  it("optimistically clears surface unread_count and decrements parent workspace unread_count", () => {
    const initial = sampleWorkspaces();
    expect(totalUnreadNotifications(initial)).toBe(2);

    // Unrelated surface returns exact same reference
    expect(clearSurfaceUnreadInWorkspaces(initial, "surf-missing")).toBe(initial);

    // Viewing surf-a clears its 1 unread and decrements ws-1 from 2 -> 1
    const afterA = clearSurfaceUnreadInWorkspaces(initial, "surf-a");
    expect(afterA[0].unread_count).toBe(1);
    expect(afterA[0].surfaces[0].unread_count).toBe(0);
    expect(afterA[0].surfaces[1].unread_count).toBe(1);

    // mergeWorkspaces detects unread_count changes and updates references cleanly
    const remerged = mergeWorkspaces(afterA, initial);
    expect(remerged[0].unread_count).toBe(2);
    expect(remerged[0].surfaces[0].unread_count).toBe(1);
  });

  it("renders chat-syncing-pill when cached turns are displayed before live snapshot confirmation", () => {
    const html = renderToStaticMarkup(
      <ChatVirtualizedTimeline
        timeline={[
          {
            kind: "user",
            id: "t-1",
            turn: {
              id: "t-1",
              surface_id: "surf-a",
              role: "user",
              events: [{ kind: "user", text: "cached prompt" }],
            },
            texts: ["cached prompt"],
            imagePreviews: [],
            images: [],
            pending: false,
          },
        ]}
        virtualItems={[]}
        totalVirtualHeight={120}
        scrollMargin={0}
        measureElement={() => {}}
        scrollContainerRef={createRef()}
        contentRef={createRef()}
        sizerRef={createRef()}
        bottomAnchorRef={createRef()}
        agentKind="antigravity"
        liveActivity={{ visible: false, activityText: null, stopping: false }}
        hasEarlier={false}
        isLoading={false}
        isSyncing
        connState="connected"
        isLoadingOlder={false}
        isScrolledUp={false}
        onScroll={() => {}}
        onLoadEarlier={() => {}}
        onJumpToTail={() => {}}
      />,
    );

    expect(html).toContain('data-testid="chat-syncing-pill"');
    expect(html).toContain("Syncing latest…");
    expect(html).toContain('data-testid="chat-watermark"');
    expect(html).not.toContain("<img");
  });

  it("renders crisp vector SVGs for all agents in monochrome mode (never stretched PNGs)", () => {
    for (const kind of ["claude", "codex", "antigravity", "kiro", "opencode"]) {
      const svgHtml = renderToStaticMarkup(<AgentIcon kind={kind} size={42} monochrome />);
      expect(svgHtml).toContain("<svg");
      expect(svgHtml).not.toContain("<img");
    }
  });
});
