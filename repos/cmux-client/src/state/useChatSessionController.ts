import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  buildTranscriptCacheKey,
  peekCachedChatTranscript,
} from "../components/chat/chatTranscriptCache";
import {
  createInitialChatSessionState,
  hasFreshPendingSends,
  reduceChatSession,
} from "../domain/chat/transcriptReducer";
import { surfaceIdentity } from "../domain/workspaceTree";
import type { SurfaceNode, WorkspaceNode } from "../protocol/rpc";
import { wsClient, type ConnectionState } from "../transport/wsClient";
import { useChatRpcActions } from "./useChatRpcActions";
import { useChatSubscription } from "./useChatSubscription";

export function useChatSessionController({
  surface,
  workspace,
  onRefresh,
}: {
  surface: SurfaceNode;
  workspace: WorkspaceNode;
  onRefresh?: () => void;
}) {
  const hasAgent = Boolean(surface.agent);
  const surfaceKey = surfaceIdentity(surface);
  const agentSid = surface.agent?.session_id;
  const agentKd = surface.agent?.agent_kind;
  const agentTranscriptPath = surface.agent?.transcript_path;

  const [connState, setConnState] = useState<ConnectionState>(() => wsClient.getState());
  useEffect(() => wsClient.onStateChange((s) => setConnState(s)), []);

  const endpoint = wsClient.getEndpoint();
  const cacheIdentity = useMemo(
    () =>
      buildTranscriptCacheKey({
        endpoint,
        surfaceKey,
        agentKind: agentKd,
        sessionId: agentSid,
        transcriptPath: agentTranscriptPath,
      }),
    [endpoint, surfaceKey, agentKd, agentSid, agentTranscriptPath],
  );

  const [state, dispatch] = useReducer(reduceChatSession, cacheIdentity, (id) =>
    createInitialChatSessionState(id, peekCachedChatTranscript(id)),
  );

  const [viewMode, setViewMode] = useState<"chat" | "terminal">(hasAgent ? "chat" : "terminal");
  const isFollowingRef = useRef(true);
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const setFollowing = useCallback((following: boolean) => {
    isFollowingRef.current = following;
  }, []);

  const prevAgentRef = useRef(surface.agent);
  useEffect(() => {
    if (!prevAgentRef.current && surface.agent) setViewMode("chat");
    prevAgentRef.current = surface.agent;
  }, [surface.agent]);

  // Reset ALL session state cleanly when `cacheIdentity` changes (e.g. `/clear` or agent restart).
  const prevCacheIdentityRef = useRef(cacheIdentity);
  useEffect(() => {
    if (prevCacheIdentityRef.current === cacheIdentity) return;
    prevCacheIdentityRef.current = cacheIdentity;
    dispatch({
      type: "RESET_FOR_IDENTITY",
      cacheIdentity,
      cached: peekCachedChatTranscript(cacheIdentity),
      now: Date.now(),
    });
  }, [cacheIdentity]);

  const chatAvailable = hasAgent || Boolean(state.startupDialog);
  const activeMode: "chat" | "terminal" = chatAvailable ? viewMode : "terminal";
  const chatSubscriptionEnabled = chatAvailable && activeMode === "chat";

  const { subscribedRef, loadSessionTurns } = useChatSubscription({
    connState,
    surface,
    surfaceKey,
    agentSid,
    agentKd,
    hasAgent,
    cacheIdentity,
    chatSubscriptionEnabled,
    state,
    stateRef,
    isFollowingRef,
    dispatch,
  });

  const {
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
  } = useChatRpcActions({
    surfaceKey,
    workspaceId: workspace.id,
    agentSid,
    agentKd,
    stateRef,
    subscribedRef,
    dispatch,
    loadSessionTurns,
    onRefresh,
  });

  const withinGrace = hasFreshPendingSends(state.pendingSends, state.now);

  return {
    connState,
    surfaceKey,
    chatAvailable,
    activeMode,
    setViewMode,
    turns: state.turns,
    pendingSends: state.pendingSends,
    withinGrace,
    initialLoading: state.initialLoading,
    snapshotConfirmed: state.snapshotConfirmed,
    hasMoreHistory: state.hasMoreHistory,
    loadingOlder: state.loadingOlder,
    startupDialog: state.startupDialog,
    isWorking: state.isWorking,
    lifecycleState: state.lifecycleState,
    activityText: state.activityText,
    awaitingPrompt: state.awaitingPrompt,
    isApproving,
    forkStatus,
    setFollowing,
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
