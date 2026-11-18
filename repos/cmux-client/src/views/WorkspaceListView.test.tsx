import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { WorkspaceListView } from "./WorkspaceListView";
import type { WorkspaceNode } from "../protocol/rpc";

describe("WorkspaceListView", () => {
  it("renders welcome onboarding when hostsCount is 0", () => {
    const html = renderToStaticMarkup(
      <WorkspaceListView
        workspaces={[]}
        loading={false}
        onRefresh={() => {}}
        onSelectWorkspace={() => {}}
        hostsCount={0}
        onPairHost={() => {}}
      />,
    );

    expect(html).toContain("Welcome to Cmob");
    expect(html).toContain("Connect Your Computer");
    expect(html).toContain("$ cmob qr --tailscale");
  });

  it("does not flash onboarding when actively connecting", () => {
    const html = renderToStaticMarkup(
      <WorkspaceListView
        workspaces={[]}
        loading={false}
        onRefresh={() => {}}
        onSelectWorkspace={() => {}}
        hostsCount={0}
        connState="connecting"
        onPairHost={() => {}}
      />,
    );

    expect(html).not.toContain("Welcome to Cmob");
  });

  it("renders empty workspaces notice when hostsCount > 0 and no workspaces exist", () => {
    const html = renderToStaticMarkup(
      <WorkspaceListView
        workspaces={[]}
        loading={false}
        onRefresh={() => {}}
        onSelectWorkspace={() => {}}
        hostsCount={1}
      />,
    );

    expect(html).not.toContain("Welcome to Cmob");
    expect(html).toContain("No active workspaces found in cmux.");
  });

  it("renders workspace items when present", () => {
    const mockWs: WorkspaceNode[] = [
      {
        id: "ws-1",
        ref: "ws:1",
        title: "Backend API",
        status: "running",
        pinned: false,
        selected: true,
        surfaces: [],
        current_directory: "/home/user/project",
      },
    ];

    const html = renderToStaticMarkup(
      <WorkspaceListView
        workspaces={mockWs}
        loading={false}
        onRefresh={() => {}}
        onSelectWorkspace={() => {}}
        hostsCount={1}
      />,
    );

    expect(html).toContain("Backend API");
    expect(html).not.toContain("Welcome to Cmob");
    expect(html).not.toContain("No active workspaces found in cmux.");
  });
});
