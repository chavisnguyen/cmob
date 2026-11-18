import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { DeviceTabStrip } from "./DeviceTabStrip";
import type { SavedHost } from "../../hosts/hostStore";

const MOCK_HOSTS: SavedHost[] = [
  {
    id: "ws://127.0.0.1:8088/ws",
    name: "MacBook Pro M3",
    endpoint: "ws://127.0.0.1:8088/ws",
    token: "token1",
  },
  {
    id: "wss://studio.tailscale.net/ws",
    name: "Mac Studio",
    endpoint: "wss://studio.tailscale.net/ws",
    token: "token2",
  },
];

describe("DeviceTabStrip", () => {
  it("renders host tabs with proper names and active state", () => {
    const html = renderToStaticMarkup(
      <DeviceTabStrip
        hosts={MOCK_HOSTS}
        activeHostId="ws://127.0.0.1:8088/ws"
        connState="connected"
        onSelectHost={() => {}}
        onAddHost={() => {}}
      />,
    );

    expect(html).toContain("MacBook Pro M3");
    expect(html).toContain("Mac Studio");
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-selected="false"');
    expect(html).toContain("Add");
  });

  it("renders connecting and error state indicators", () => {
    const htmlConnecting = renderToStaticMarkup(
      <DeviceTabStrip
        hosts={MOCK_HOSTS}
        activeHostId="ws://127.0.0.1:8088/ws"
        connState="connecting"
        onSelectHost={() => {}}
        onAddHost={() => {}}
      />,
    );
    expect(htmlConnecting).toContain("bg-amber-400");

    const htmlError = renderToStaticMarkup(
      <DeviceTabStrip
        hosts={MOCK_HOSTS}
        activeHostId="ws://127.0.0.1:8088/ws"
        connState="error"
        onSelectHost={() => {}}
        onAddHost={() => {}}
      />,
    );
    expect(htmlError).toContain("bg-rose-400");
  });
});
