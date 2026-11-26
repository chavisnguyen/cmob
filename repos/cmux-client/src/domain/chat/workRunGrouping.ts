import type { AgentEvent, AwaitingInput } from "../../protocol/event";
import { normalizeAssistantTurnSteps, type NormalizedTurnStep } from "./toolPairing";
import type { AssistantBlockItem, ThoughtStepItem, ToolCallItem, WorkRunStepItem } from "./types";

type WorkCandidate = Extract<NormalizedTurnStep, { kind: "thinking" | "tool" }>;

/**
 * Groups normalized assistant steps into Orca-style `AssistantBlockItem[]`:
 * - Coalesces adjacent settled `thinking` + `tool` steps between prose/ask/subagent/task
 *   boundaries into a cohesive `WorkRunBlock` (showing interleaved thoughts + tools + diffs
 *   when expanded).
 * - Keeps a standalone settled `thinking` step (with zero tools in that segment) as a
 *   `LiveReasoningBlock` (`live: false`, `"Thought for Ns"` / `"Thought"`).
 * - Keeps any trailing live `Reasoning` step separate from the preceding `WorkRunBlock`.
 */
export function buildAssistantBlocks(params: {
  turnId: string;
  events: readonly AgentEvent[];
  isLastTurn: boolean;
  isWorking: boolean;
  activeAwaitingEventIdx: number | null;
  activeAwaitingRef: AwaitingInput | null;
}): AssistantBlockItem[] {
  const { turnId, events, isLastTurn, isWorking, activeAwaitingEventIdx, activeAwaitingRef } =
    params;
  const steps = normalizeAssistantTurnSteps(turnId, events);
  const blocks: AssistantBlockItem[] = [];
  let pendingWork: WorkCandidate[] = [];

  const emitSingleReasoning = (
    step: Extract<NormalizedTurnStep, { kind: "thinking" }>,
    live: boolean,
  ) => {
    blocks.push({
      kind: "live-reasoning",
      key: `${turnId}:th:${step.thought.id}`,
      id: step.thought.id,
      text: step.thought.text,
      durationSeconds: step.thought.durationSeconds,
      live,
    });
  };

  const flushWorkSegment = (isTailOfTurn: boolean) => {
    if (pendingWork.length === 0) return;
    const segment = pendingWork;
    pendingWork = [];

    // Separate trailing live `Reasoning` so it pulses right above the composer / tail.
    let trailingLiveReasoning: Extract<NormalizedTurnStep, { kind: "thinking" }> | null = null;
    if (isTailOfTurn && isLastTurn && isWorking) {
      const last = segment[segment.length - 1];
      if (last && last.kind === "thinking") {
        trailingLiveReasoning = last;
        segment.pop();
      }
    }

    if (segment.length > 0) {
      const tools: ToolCallItem[] = [];
      const thoughts: ThoughtStepItem[] = [];
      const workSteps: WorkRunStepItem[] = [];

      for (const item of segment) {
        if (item.kind === "tool") {
          tools.push(item.tool);
          workSteps.push({ kind: "tool", tool: item.tool });
        } else {
          thoughts.push(item.thought);
          workSteps.push({ kind: "thinking", thought: item.thought });
        }
      }

      if (tools.length === 0) {
        // Settled thought(s) without any tools in this segment render as standalone Thought rows.
        for (const item of segment) {
          if (item.kind === "thinking") {
            emitSingleReasoning(item, false);
          }
        }
      } else {
        const firstAnchor = segment[0].kind === "tool" ? segment[0].tool.id : segment[0].thought.id;
        const totalThoughtSeconds = thoughts.reduce((acc, t) => acc + (t.durationSeconds ?? 0), 0);
        blocks.push({
          kind: "work-run",
          key: `${turnId}:wr:${firstAnchor}`,
          steps: workSteps,
          tools,
          thoughts,
          totalThoughtSeconds,
          live: Boolean(isLastTurn && isWorking && tools.some((t) => !t.isEnd)),
        });
      }
    }

    if (trailingLiveReasoning) {
      emitSingleReasoning(trailingLiveReasoning, true);
    }
  };

  for (let idx = 0; idx < steps.length; idx += 1) {
    const step = steps[idx];
    if (step.kind === "thinking" || step.kind === "tool") {
      pendingWork.push(step);
      continue;
    }

    flushWorkSegment(false);

    switch (step.kind) {
      case "prose":
        blocks.push({
          kind: "prose",
          key: `${turnId}:prose:${step.eventIdx}`,
          text: step.text,
        });
        break;
      case "subagents":
        blocks.push({
          kind: "subagents",
          key: `${turnId}:sub:${step.groupId}:${step.eventIdx}`,
          groupId: step.groupId,
          agents: step.agents,
        });
        break;
      case "background-tasks":
        blocks.push({
          kind: "background-tasks",
          key: `${turnId}:bg:${step.eventIdx}`,
          tasks: step.tasks,
        });
        break;
      case "awaiting-input": {
        const isPending =
          isLastTurn &&
          (activeAwaitingEventIdx !== null
            ? activeAwaitingEventIdx === step.eventIdx
            : activeAwaitingRef === step.awaiting);
        blocks.push({
          kind: "awaiting-input",
          key: `${turnId}:ask:${step.eventIdx}`,
          eventIdx: step.eventIdx,
          awaiting: step.awaiting,
          pending: isPending,
        });
        break;
      }
      case "status":
        blocks.push({
          kind: "status",
          key: `${turnId}:status:${step.eventIdx}`,
          text: step.text,
        });
        break;
      case "error":
        blocks.push({
          kind: "error",
          key: `${turnId}:err:${step.eventIdx}`,
          message: step.message,
        });
        break;
    }
  }

  flushWorkSegment(true);
  return blocks;
}
