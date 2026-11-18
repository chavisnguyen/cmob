import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { BottomTabBar } from "./BottomTabBar";

describe("BottomTabBar", () => {
  it("renders all 3 primary navigation tabs", () => {
    const html = renderToStaticMarkup(
      <BottomTabBar activeTab="workspaces" onSelectTab={() => {}} />,
    );
    expect(html).toContain("Workspaces");
    expect(html).toContain("Devices");
    expect(html).toContain("Settings");
  });

  it("marks active tab with aria-selected", () => {
    const html = renderToStaticMarkup(<BottomTabBar activeTab="devices" onSelectTab={() => {}} />);
    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-selected="true"');
  });

  it("renders badge counter when greater than zero", () => {
    const htmlWithBadge = renderToStaticMarkup(
      <BottomTabBar activeTab="workspaces" onSelectTab={() => {}} workspaceBadge={3} />,
    );
    expect(htmlWithBadge).toContain("3");

    const htmlNoBadge = renderToStaticMarkup(
      <BottomTabBar activeTab="workspaces" onSelectTab={() => {}} workspaceBadge={0} />,
    );
    expect(htmlNoBadge).not.toContain("bg-rose-500");
  });
});
