import { describe, expect, it } from "vite-plus/test";
import type { AgentTurn } from "../../protocol/event";
import { buildTimelineItemForTurn } from "./chatViewModel";
import { computeTurnDigest } from "./turnMerge";

const params = (turn: AgentTurn) => ({
  turn,
  isLastTurn: false,
  isWorking: false,
  activeAwaitingEventIdx: null,
  activeAwaitingRef: null,
});

const userTurn = (events: AgentTurn["events"]): AgentTurn => ({
  id: "t1",
  surface_id: "s",
  role: "user",
  events,
});

describe("user prompt images", () => {
  it("collects transcript image refs and drops the placeholder badge", () => {
    const item = buildTimelineItemForTurn(
      params(
        userTurn([
          { kind: "user", text: "[Image #1]" },
          { kind: "user-image", image_id: "u-1#0", media_type: "image/png" },
        ]),
      ),
    );
    if (item.kind !== "user") throw new Error("expected user item");
    expect(item.images).toEqual([{ id: "u-1#0", mediaType: "image/png" }]);
    expect(item.texts).toEqual([]);
  });

  it("keeps the user's own text next to the images", () => {
    const item = buildTimelineItemForTurn(
      params(
        userTurn([
          { kind: "user", text: "what is wrong here? [Image #1]" },
          { kind: "user-image", image_id: "u-2#0", media_type: "image/jpeg" },
        ]),
      ),
    );
    if (item.kind !== "user") throw new Error("expected user item");
    expect(item.texts).toEqual(["what is wrong here?"]);
    expect(item.images).toHaveLength(1);
  });

  it("keeps the badge when no image bytes are available (older gateways)", () => {
    const item = buildTimelineItemForTurn(params(userTurn([{ kind: "user", text: "[Image #1]" }])));
    if (item.kind !== "user") throw new Error("expected user item");
    expect(item.images).toEqual([]);
    expect(item.texts[0]).toContain("Image");
  });

  it("changes the turn digest when an image is added", () => {
    const base = userTurn([{ kind: "user", text: "hi" }]);
    const withImage = userTurn([
      { kind: "user", text: "hi" },
      { kind: "user-image", image_id: "x#0", media_type: "image/png" },
    ]);
    expect(computeTurnDigest(base)).not.toBe(computeTurnDigest(withImage));
  });
});
