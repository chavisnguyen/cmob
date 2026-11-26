import { useCallback, useState, type Dispatch } from "react";
import { PartialSendError, formatImagePastePath } from "../components/chat/imageAttach";
import type { QuestionAnswerPayload } from "../components/chat/MobileNativeChatPromptCard";
import {
  MAX_TURN_LIMIT,
  OLDER_TURN_PAGE_SIZE,
  createPendingSendItem,
  type ChatSessionAction,
  type ChatSessionState,
} from "../domain/chat/transcriptReducer";
import type { WireSessionFrame } from "../domain/chat/types";
import { RPC_METHODS } from "../protocol/rpc";
import { wsClient } from "../transport/wsClient";

export function useChatRpcActions({
  surfaceKey,
  workspaceId,
  agentSid,
  agentKd,
  stateRef,
  subscribedRef,
  dispatch,
  loadSessionTurns,
  onRefresh,
}: {
  surfaceKey: string;
  workspaceId: string;
  agentSid?: string;
  agentKd?: string;
  stateRef: React.RefObject<ChatSessionState>;
  subscribedRef: React.RefObject<boolean>;
  dispatch: Dispatch<ChatSessionAction>;
  loadSessionTurns: (requestedMaxTurns?: number) => Promise<void>;
  onRefresh?: () => void;
}) {
  const [isApproving, setIsApproving] = useState(false);
  const [forkStatus, setForkStatus] = useState<string | null>(null);

  const handleLoadOlder = useCallback(async () => {
    const cur = stateRef.current;
    if (cur.loadingOlder || !cur.hasMoreHistory) return;
    dispatch({ type: "LOAD_OLDER_START" });
    const capturedCursor = cur.beforeOffset;
    try {
      if (capturedCursor !== null) {
        const resp = await wsClient.call<WireSessionFrame>(RPC_METHODS.CHAT_READ_SESSION, {
          surface_id: surfaceKey,
          session_id: agentSid,
          agent_kind: agentKd,
          max_turns: OLDER_TURN_PAGE_SIZE,
          before_offset: capturedCursor,
        });
        if (resp && Array.isArray(resp.turns)) {
          dispatch({
            type: "LOAD_OLDER_CURSOR_SUCCESS",
            olderTurns: resp.turns,
            beforeOffset: resp.before_offset ?? null,
            hasMore: Boolean(resp.has_more),
            expectedCursor: capturedCursor,
            now: Date.now(),
          });
          return;
        }
      } else {
        const nextLimit = Math.min(
          MAX_TURN_LIMIT,
          Math.max(cur.turnLimit, cur.turns.length) + OLDER_TURN_PAGE_SIZE,
        );
        const resp = await wsClient.call<WireSessionFrame>(RPC_METHODS.CHAT_READ_SESSION, {
          surface_id: surfaceKey,
          session_id: agentSid,
          agent_kind: agentKd,
          max_turns: nextLimit,
        });
        if (resp && Array.isArray(resp.turns)) {
          dispatch({
            type: "LOAD_OLDER_WINDOW_SUCCESS",
            turns: resp.turns,
            nextTurnLimit: nextLimit,
            hasMore: Boolean(resp.has_more),
            now: Date.now(),
          });
          return;
        }
      }
      dispatch({ type: "LOAD_OLDER_FINISH" });
    } catch (err) {
      console.warn("Failed to load older turns:", err);
      dispatch({ type: "LOAD_OLDER_FINISH" });
    }
  }, [surfaceKey, agentSid, agentKd, stateRef, dispatch]);

  const handleSendPrompt = useCallback(
    async (text: string, imagePaths: string[] = [], imagePreviews?: string[]) => {
      const now = Date.now();
      const pending = createPendingSendItem({
        id: `pending-${now}-${Math.random().toString(36).slice(2, 7)}`,
        text,
        turns: stateRef.current.turns,
        now,
        imagePreviews,
      });
      dispatch({ type: "ADD_PENDING_SEND", pending, now });

      let delivered = 0;
      try {
        for (const path of imagePaths) {
          const pasted = formatImagePastePath(path);
          if (!pasted) throw new Error("Attachment path is not valid.");
          await wsClient.call(
            RPC_METHODS.CHAT_SEND,
            { surface_id: surfaceKey, agent_kind: agentKd, text: pasted, enter: false },
            { timeoutMs: 30_000 },
          );
          delivered += 1;
        }
        await wsClient.call(
          RPC_METHODS.CHAT_SEND,
          { surface_id: surfaceKey, agent_kind: agentKd, text, enter: true },
          { timeoutMs: 30_000 },
        );
      } catch (err) {
        dispatch({ type: "REMOVE_PENDING_SEND", id: pending.id, now: Date.now() });
        if (imagePaths.length > 0) {
          throw new PartialSendError(
            err instanceof Error ? err.message : "Could not send the message.",
            delivered,
          );
        }
        throw err;
      }
      if (!subscribedRef.current) {
        setTimeout(() => void loadSessionTurns(), 600);
      }
    },
    [surfaceKey, agentKd, stateRef, subscribedRef, dispatch, loadSessionTurns],
  );

  const handleUploadImage = useCallback(async (base64: string): Promise<string> => {
    const resp = await wsClient.call<{ path: string }>(
      RPC_METHODS.UPLOAD_IMAGE,
      { content_base64: base64 },
      { timeoutMs: 30_000 },
    );
    return resp.path;
  }, []);

  const handleAnswerDialog = useCallback(
    async (choice: number) => {
      const dialog = stateRef.current.startupDialog;
      if (!dialog) return;
      await wsClient.call(RPC_METHODS.CHAT_ANSWER_DIALOG, {
        surface_id: surfaceKey,
        fingerprint: dialog.fingerprint,
        choice,
      });
      dispatch({ type: "CLEAR_STARTUP_DIALOG" });
      if (!subscribedRef.current) await loadSessionTurns();
    },
    [surfaceKey, stateRef, subscribedRef, dispatch, loadSessionTurns],
  );

  const handleAnswerQuestion = useCallback(
    async (payload: QuestionAnswerPayload) => {
      dispatch({ type: "MARK_OPTIMISTIC_WORKING", now: Date.now() });
      const steps =
        payload.steps && payload.steps.length > 0
          ? payload.steps
          : [
              {
                indices: payload.indices,
                other: payload.other,
                optionCount: payload.optionCount,
                multiSelect: payload.multiSelect,
              },
            ];
      try {
        if (steps.length > 1) {
          await wsClient.call(
            RPC_METHODS.CHAT_ANSWER_QUESTION,
            {
              surface_id: surfaceKey,
              agent_kind: agentKd || "agent",
              answers: steps.map((step) => ({
                indices: step.indices,
                ...(step.other ? { other: step.other } : {}),
                option_count: step.optionCount,
                multi_select: step.multiSelect,
              })),
            },
            { timeoutMs: 20_000 },
          );
        } else {
          const step = steps[0];
          await wsClient.call(
            RPC_METHODS.CHAT_ANSWER_QUESTION,
            {
              surface_id: surfaceKey,
              agent_kind: agentKd || "agent",
              indices: step.indices,
              ...(step.other ? { other: step.other } : {}),
              option_count: step.optionCount,
              multi_select: step.multiSelect,
            },
            { timeoutMs: 20_000 },
          );
        }
      } catch (err) {
        dispatch({ type: "REVERT_OPTIMISTIC_WORKING", lifecycleState: "waiting", now: Date.now() });
        throw err;
      }
      if (!subscribedRef.current) {
        setTimeout(() => void loadSessionTurns(), 450);
      }
    },
    [surfaceKey, agentKd, subscribedRef, dispatch, loadSessionTurns],
  );

  const handleApprove = useCallback(async () => {
    if (!agentKd || isApproving) return;
    setIsApproving(true);
    try {
      await wsClient.call(RPC_METHODS.CHAT_APPROVE, {
        surface_id: surfaceKey,
        agent_kind: agentKd,
      });
      if (!subscribedRef.current) await loadSessionTurns();
    } catch (err) {
      setForkStatus(`Approve failed: ${err instanceof Error ? err.message : "unknown error"}`);
      setTimeout(() => setForkStatus(null), 4000);
    } finally {
      setIsApproving(false);
    }
  }, [agentKd, isApproving, surfaceKey, subscribedRef, loadSessionTurns]);

  const handleInterrupt = useCallback(async () => {
    await wsClient.call(RPC_METHODS.CHAT_INTERRUPT, {
      surface_id: surfaceKey,
      ...(agentKd ? { agent_kind: agentKd } : {}),
    });
  }, [surfaceKey, agentKd]);

  const handleForkConversation = useCallback(async () => {
    if (!agentSid) return;
    setForkStatus("Forking…");
    try {
      await wsClient.call(RPC_METHODS.CHAT_FORK, {
        workspace_id: workspaceId,
        session_id: agentSid,
        agent_kind: agentKd,
      });
      setForkStatus("Forked into a new tab");
      onRefresh?.();
    } catch (err) {
      setForkStatus(err instanceof Error ? err.message : "Could not fork the conversation.");
    }
    setTimeout(() => setForkStatus(null), 4000);
  }, [agentSid, agentKd, workspaceId, onRefresh]);

  return {
    isApproving,
    forkStatus,
    handleLoadOlder,
    handleSendPrompt,
    handleUploadImage,
    handleAnswerDialog,
    handleAnswerQuestion,
    handleApprove,
    handleInterrupt,
    handleForkConversation,
  };
}
