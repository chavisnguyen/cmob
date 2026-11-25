import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { AgentTurn } from "../../protocol/event";
import { ChangesPanel } from "../git/ChangesPanel";
import { MobileNativeChatDiffCard } from "./MobileNativeChatDiffCard";
import { ChatTurnRow, OrcaChatView } from "./OrcaChatView";
import {
  createProgrammaticScrollMarks,
  estimateTurnHeight,
  resolveSystemDividerLabel,
} from "./chatVirtual";

function makeTurn(index: number): AgentTurn {
  if (index % 2 === 0) {
    return {
      id: `user-${index}`,
      surface_id: "surf-1",
      role: "user",
      events: [{ kind: "user", text: `Prompt #${index}` }],
    };
  }
  return {
    id: `ast-${index}`,
    surface_id: "surf-1",
    role: "assistant",
    events: [
      { kind: "thinking", text: "Checking module imports" },
      { kind: "tool-start", tool_id: `t-${index}`, name: "read_file", detail: "foo.ts" },
      { kind: "tool-end", tool_id: `t-${index}`, ok: true },
      { kind: "assistant", text: `Response paragraph for turn ${index}.` },
    ],
  };
}

describe("chatVirtual helpers", () => {
  it("estimates larger heights for multi-block assistant turns than compact user turns", () => {
    const shortUser = estimateTurnHeight(makeTurn(0));
    const richAssistant = estimateTurnHeight(makeTurn(1));
    const longProse = estimateTurnHeight({
      id: "long",
      surface_id: "surf-1",
      role: "assistant",
      events: [{ kind: "assistant", text: "Line\n".repeat(30) }],
    });

    expect(shortUser).toBeGreaterThanOrEqual(44);
    expect(richAssistant).toBeGreaterThan(shortUser);
    expect(longProse).toBeGreaterThan(richAssistant);
  });

  it("caps collapsed long user prompt estimates and respects minimum height", () => {
    const emptyTurn = estimateTurnHeight({
      id: "empty",
      surface_id: "surf-1",
      role: "assistant",
      events: [{ kind: "done" }],
    });
    const hugeUser = estimateTurnHeight({
      id: "huge-u",
      surface_id: "surf-1",
      role: "user",
      events: [{ kind: "user", text: "x\n".repeat(200) }],
    });

    expect(emptyTurn).toBe(44);
    expect(hugeUser).toBeLessThanOrEqual(200);
  });

  it("consumes programmatic scroll marks once and expires stale marks", () => {
    const marks = createProgrammaticScrollMarks(100);
    const fakeEl = {} as Element;
    const otherEl = {} as Element;

    expect(marks.consume(fakeEl, 1000)).toBe(false);

    marks.mark(fakeEl);
    expect(marks.consume(otherEl)).toBe(false);
    expect(marks.consume(fakeEl)).toBe(true);
    // Second consume for the same write returns false.
    expect(marks.consume(fakeEl)).toBe(false);

    marks.mark(fakeEl);
    expect(marks.consume(fakeEl, performance.now() + 500)).toBe(false);
  });
});

describe("virtualized components SSR compatibility", () => {
  it("renders OrcaChatView safely with many turns", () => {
    const turns = Array.from({ length: 80 }, (_, idx) => makeTurn(idx));
    const html = renderToStaticMarkup(
      <OrcaChatView
        turns={turns}
        agentKind="claude"
        onSend={async () => {}}
        onApprove={async () => {}}
        onInterrupt={async () => {}}
      />,
    );

    expect(html).toContain('placeholder="Message Claude Code..."');
    expect(html).toContain('aria-label="Send"');
  });

  it("renders MobileNativeChatDiffCard and ChangesPanel cleanly in SSR", () => {
    const diffHtml = renderToStaticMarkup(
      <MobileNativeChatDiffCard path="src/app.ts" diff={"+added\n-removed"} />,
    );
    const changesHtml = renderToStaticMarkup(
      <ChangesPanel workspaceId="ws-1" workspaceTitle="workspace" onClose={() => {}} />,
    );

    expect(diffHtml).toContain("src/app.ts");
    expect(changesHtml).toContain("workspace");
  });

  it("detects system and legacy compaction turns for centered divider rendering", () => {
    const sysTurn: AgentTurn = {
      id: "sys-1",
      surface_id: "surf-1",
      role: "system",
      events: [{ kind: "status", text: "Context compacted" }],
    };
    const legacyCompactTurn: AgentTurn = {
      id: "u-compact",
      surface_id: "surf-1",
      role: "user",
      events: [
        {
          kind: "user",
          text: "This session is being continued from a previous conversation that ran out of context.",
        },
      ],
    };

    expect(resolveSystemDividerLabel(sysTurn)).toBe("Context compacted");
    expect(resolveSystemDividerLabel(legacyCompactTurn)).toBe("Context compacted");
    expect(estimateTurnHeight(sysTurn)).toBe(36);
    expect(estimateTurnHeight(legacyCompactTurn)).toBe(36);

    const sysHtml = renderToStaticMarkup(
      <ChatTurnRow
        turn={sysTurn}
        isLastTurn={false}
        isWorking={false}
        activeAwaiting={null}
        onSubmitAwaiting={async () => {}}
      />,
    );
    const legacyHtml = renderToStaticMarkup(
      <ChatTurnRow
        turn={legacyCompactTurn}
        isLastTurn={false}
        isWorking={false}
        activeAwaiting={null}
        onSubmitAwaiting={async () => {}}
      />,
    );

    expect(sysHtml).toContain('role="separator"');
    expect(sysHtml).toContain("Context compacted");
    expect(legacyHtml).toContain('role="separator"');
    expect(legacyHtml).toContain("Context compacted");
    expect(legacyHtml).not.toContain("SYSTEM MESSAGE");
  });
});
