import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { CreateSurfaceParams } from "../components/surface/NewSurfaceModal";
import {
  ChevronDown,
  ChevronLeft,
  GitFork,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Terminal,
  X,
} from "lucide-react";
import { RPC_EVENTS, RPC_METHODS, type SurfaceNode, type WorkspaceNode } from "../protocol/rpc";
import type { AgentTurn, AgentLifecycleState, StartupDialogInfo } from "../protocol/event";
import { OrcaChatView } from "../components/chat/OrcaChatView";
import { RawTerminalView } from "../components/terminal/RawTerminalView";
import { SurfaceSwitchSheet } from "../components/surface/SurfaceSwitchSheet";
import { displaySurfaceTitle } from "../components/surface/surfaceTitle";
import { NewSurfaceModal } from "../components/surface/NewSurfaceModal";
import { RenameSurfaceModal } from "../components/surface/RenameSurfaceModal";
import { CloseSurfaceDialog } from "../components/surface/CloseSurfaceDialog";
import { wsClient, type ConnectionState } from "../transport/wsClient";
import { PartialSendError, formatImagePastePath } from "../components/chat/imageAttach";

/** One short line only: collapse whitespace, take the first line, cap length (never show prose). */
function cleanActivity(text: string | null | undefined): string | null {
  const line = text?.split("\n")[0]?.replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

interface PendingSend {
  id: string;
  text: string;
  /** How many user turns already had this exact text when it was sent. */
  baseline: number;
  createdAt: number;
}

/** A pending send that never shows up in the transcript is dropped after this long. */
const PENDING_SEND_TTL_MS = 90_000;
/** While a fresh send is unconfirmed, keep showing "Thinking…" even if the hook still says idle. */
const PENDING_WORKING_GRACE_MS = 20_000;

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function userTurnTexts(turns: AgentTurn[]): string[] {
  return turns
    .filter((t) => t.role === "user")
    .map((t) => normalizeText(t.events.map((e) => (e.kind === "user" ? e.text : "")).join(" ")));
}

function countUserTurnsWithText(turns: AgentTurn[], text: string): number {
  const wanted = normalizeText(text);
  return userTurnTexts(turns).filter((t) => t === wanted).length;
}

/** Turns fetched per page (initial load and each "load older"). */
const TURN_PAGE_SIZE = 15;
/** Gateway caps `max_turns` at 500 (server.rs handle_subscription / readSession). */
const MAX_TURN_LIMIT = 500;

interface SessionSnapshot {
  turns: AgentTurn[];
  agent_kind?: string;
  is_working?: boolean;
  lifecycle_state?: AgentLifecycleState;
  last_event?: string;
  last_subtitle?: string;
  /** Live "what the agent is doing now" (e.g. "Running execute_bash"); never prose. */
  activity?: string | null;
  surface_id?: string;
  /** The startup dialog on the agent's screen, if any. */
  startup_dialog?: StartupDialogInfo | null;
  /** Gateway: older turns exist beyond `turns`. */
  has_more?: boolean;
  total_turns?: number;
}

interface SurfaceDetailViewProps {
  surface: SurfaceNode;
  workspace: WorkspaceNode;
  onBack: () => void;
  allSurfaces?: SurfaceNode[];
  onSelectSurface?: (surface: SurfaceNode) => void;
  onCreateSurface?: (params: CreateSurfaceParams) => Promise<void>;
  onRenameSurface?: (surfaceId: string, title: string) => Promise<void>;
  onCloseSurface?: (surfaceId: string) => Promise<void>;
  /** Re-reads the workspace tree (used after forking so the new tab shows up). */
  onRefresh?: () => void;
}

/** Agents the gateway can fork from here (mirror of `fork` in gateway cmux/agents.rs; the gateway decides). */
const FORKABLE_AGENTS = new Set(["claude"]);

export function SurfaceDetailView({
  surface,
  workspace,
  onBack,
  allSurfaces,
  onSelectSurface,
  onCreateSurface,
  onRenameSurface,
  onCloseSurface,
  onRefresh,
}: SurfaceDetailViewProps) {
  const hasAgent = Boolean(surface.agent);
  const [viewMode, setViewMode] = useState<"chat" | "terminal">(hasAgent ? "chat" : "terminal");
  const [turns, setTurns] = useState<AgentTurn[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  // How many recent turns we ask the gateway for; grows when the user pulls older history.
  const [turnLimit, setTurnLimit] = useState(TURN_PAGE_SIZE);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Messages sent from this phone that the transcript has not echoed yet (Orca: pendingSendsAsMessages).
  const [pendingSends, setPendingSends] = useState<PendingSend[]>([]);
  const [withinGrace, setWithinGrace] = useState(false);
  const [startupDialog, setStartupDialog] = useState<StartupDialogInfo | null>(null);
  // A plain shell has nobody to chat with: only agents (and their startup dialogs) get the Chat view.
  const chatAvailable = hasAgent || Boolean(startupDialog);
  const activeMode: "chat" | "terminal" = chatAvailable ? viewMode : "terminal";
  const [isWorking, setIsWorking] = useState(false);
  const [lifecycleState, setLifecycleState] = useState<AgentLifecycleState>("idle");
  const [activityText, setActivityText] = useState<string | null>(null);
  const [connState, setConnState] = useState<ConnectionState>(wsClient.getState());

  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [forkStatus, setForkStatus] = useState<string | null>(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [surfaceToRename, setSurfaceToRename] = useState<SurfaceNode | null>(null);
  const [surfaceToClose, setSurfaceToClose] = useState<SurfaceNode | null>(null);

  useEffect(() => {
    return wsClient.onStateChange((state) => {
      setConnState(state);
    });
  }, []);

  const prevAgentRef = useRef(surface.agent);
  useEffect(() => {
    if (!prevAgentRef.current && surface.agent) {
      setViewMode("chat");
    }
    prevAgentRef.current = surface.agent;
  }, [surface.agent]);

  const applySnapshot = useCallback((resp: SessionSnapshot) => {
    if (resp.turns) {
      setTurns((prev) => {
        if (prev.length === resp.turns.length && prev.length > 0) {
          const lastPrev = prev[prev.length - 1];
          const lastNext = resp.turns[resp.turns.length - 1];
          if (lastPrev.id === lastNext.id && lastPrev.events.length === lastNext.events.length) {
            return prev;
          }
        }
        return resp.turns;
      });
    }
    if (resp.has_more !== undefined) {
      setHasMoreHistory(resp.has_more);
    }
    // Gateways without the field never report a dialog.
    setStartupDialog(resp.startup_dialog ?? null);
    if (resp.lifecycle_state) {
      setLifecycleState(resp.lifecycle_state);
    } else if (resp.is_working !== undefined) {
      setLifecycleState(resp.is_working ? "working" : "idle");
    }
    if (resp.is_working !== undefined) {
      setIsWorking(resp.is_working);
      if (resp.is_working) {
        setActivityText(cleanActivity(resp.activity) ?? "Thinking…");
      } else {
        setActivityText(null);
      }
    }
    setInitialLoading(false);
  }, []);

  const loadingRef = useRef(false);
  // Primitive identity of the agent: App refreshes the workspace tree every 2.5 s and hands down a new
  // `surface.agent` object each time, which would otherwise rebuild this callback and restart the poll timer.
  const agentSid = surface.agent?.session_id;
  const agentKd = surface.agent?.agent_kind;
  const loadSessionTurns = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const resp = await wsClient.call<SessionSnapshot>("mobile.chat.readSession", {
        surface_id: surface.id || surface.ref,
        session_id: agentSid,
        agent_kind: agentKd,
        max_turns: turnLimit,
      });
      if (resp) applySnapshot(resp);
    } catch (err) {
      console.warn("Failed to load session turns:", err);
    } finally {
      loadingRef.current = false;
      setInitialLoading(false);
    }
  }, [surface.id, surface.ref, agentSid, agentKd, applySnapshot, turnLimit]);

  const [subscribed, setSubscribed] = useState(false);
  const surfaceKey = surface.id || surface.ref;
  const agentSessionId = surface.agent?.session_id;
  const agentKindForSub = surface.agent?.agent_kind;
  useEffect(() => {
    if (connState !== "connected") {
      setSubscribed(false);
      return;
    }
    const controller = new AbortController();
    const offEvent = wsClient.onEvent((event, data) => {
      if (event !== RPC_EVENTS.CHAT_UPDATE) return;
      const snap = data as SessionSnapshot;
      if (snap.surface_id && snap.surface_id !== surface.id && snap.surface_id !== surface.ref) {
        return;
      }
      applySnapshot(snap);
    });
    wsClient
      .call("mobile.chat.subscribe", {
        surface_id: surfaceKey,
        session_id: agentSessionId,
        agent_kind: agentKindForSub,
        max_turns: turnLimit,
      })
      .then(() => {
        if (!controller.signal.aborted) setSubscribed(true);
      })
      .catch((err) => console.warn("Chat subscribe failed, falling back to polling:", err));
    return () => {
      controller.abort();
      offEvent();
      setSubscribed(false);
      void wsClient.call("mobile.chat.unsubscribe", { surface_id: surfaceKey }).catch(() => {});
    };
  }, [
    connState,
    surfaceKey,
    surface.id,
    surface.ref,
    agentSessionId,
    agentKindForSub,
    applySnapshot,
    turnLimit,
  ]);

  // Reset paging when switching surface.
  useEffect(() => {
    setTurnLimit(TURN_PAGE_SIZE);
    setHasMoreHistory(false);
  }, [surfaceKey]);

  const handleLoadOlder = useCallback(async () => {
    if (loadingOlder || !hasMoreHistory) return;
    setLoadingOlder(true);
    const next = Math.min(MAX_TURN_LIMIT, turnLimit + TURN_PAGE_SIZE);
    try {
      const resp = await wsClient.call<SessionSnapshot>("mobile.chat.readSession", {
        surface_id: surface.id || surface.ref,
        session_id: agentSid,
        agent_kind: agentKd,
        max_turns: next,
      });
      if (resp) applySnapshot(resp);
      // Re-subscribes with the larger window so live pushes keep the older turns.
      setTurnLimit(next);
      if (next >= MAX_TURN_LIMIT) setHasMoreHistory(false);
    } catch (err) {
      console.warn("Failed to load older turns:", err);
    } finally {
      setLoadingOlder(false);
    }
  }, [
    loadingOlder,
    hasMoreHistory,
    turnLimit,
    surface.id,
    surface.ref,
    agentSid,
    agentKd,
    applySnapshot,
  ]);

  useEffect(() => {
    void loadSessionTurns();
    const interval = setInterval(
      () => {
        void loadSessionTurns();
      },
      subscribed ? 5000 : 1000,
    );
    return () => clearInterval(interval);
  }, [loadSessionTurns, subscribed]);

  // Drop pending sends once the transcript shows them (one more user turn with that text than at send time)
  // or after the TTL. Orca keeps them until the journal echo: native-chat-in-flight-sends.
  useEffect(() => {
    if (pendingSends.length === 0) return;
    const counts = new Map<string, number>();
    for (const t of userTurnTexts(turns)) counts.set(t, (counts.get(t) ?? 0) + 1);
    const now = Date.now();
    const used = new Map<string, number>();
    const still = pendingSends.filter((p) => {
      if (now - p.createdAt > PENDING_SEND_TTL_MS) return false;
      const key = normalizeText(p.text);
      // Several identical pending sends need several echoes.
      const needed = p.baseline + 1 + (used.get(key) ?? 0);
      used.set(key, (used.get(key) ?? 0) + 1);
      return (counts.get(key) ?? 0) < needed;
    });
    if (still.length !== pendingSends.length) setPendingSends(still);
  }, [turns, pendingSends]);

  // Expire pending sends even when no snapshot arrives.
  useEffect(() => {
    if (pendingSends.length === 0) return;
    const id = setTimeout(
      () =>
        setPendingSends((prev) =>
          prev.filter((p) => Date.now() - p.createdAt <= PENDING_SEND_TTL_MS),
        ),
      PENDING_SEND_TTL_MS + 500,
    );
    return () => clearTimeout(id);
  }, [pendingSends]);

  const displayTurns = useMemo<AgentTurn[]>(
    () => [
      ...turns,
      ...pendingSends.map((p) => ({
        id: p.id,
        surface_id: surface.id || surface.ref,
        role: "user" as const,
        events: [{ kind: "user" as const, text: p.text }],
      })),
    ],
    [turns, pendingSends, surface.id, surface.ref],
  );
  const hasFreshPending = withinGrace && pendingSends.length > 0;

  const handleUploadImage = async (base64: string): Promise<string> => {
    const resp = await wsClient.call<{ path: string }>(
      RPC_METHODS.UPLOAD_IMAGE,
      { content_base64: base64 },
      { timeoutMs: 30_000 },
    );
    return resp.path;
  };

  const handleForkConversation = async () => {
    const agent = surface.agent;
    if (!agent?.session_id) return;
    setForkStatus("Forking…");
    try {
      await wsClient.call(RPC_METHODS.CHAT_FORK, {
        workspace_id: workspace.id,
        session_id: agent.session_id,
        agent_kind: agent.agent_kind,
      });
      setForkStatus("Forked into a new tab");
      onRefresh?.();
    } catch (err) {
      setForkStatus(err instanceof Error ? err.message : "Could not fork the conversation.");
    }
    setTimeout(() => setForkStatus(null), 4000);
  };

  const handleSendPrompt = async (text: string, imagePaths: string[] = []) => {
    if (imagePaths.length > 0) {
      // Each image path goes in as its own paste (no Enter) so the TUI turns it into an attachment, then the
      // message follows. There is no transcript echo to match a pending bubble against, so none is shown.
      setIsWorking(true);
      setActivityText("Thinking…");
      let delivered = 0;
      try {
        for (const path of imagePaths) {
          const pasted = formatImagePastePath(path);
          if (!pasted) throw new Error("Attachment path is not valid.");
          await wsClient.call(
            "mobile.chat.send",
            {
              surface_id: surface.id || surface.ref,
              agent_kind: surface.agent?.agent_kind,
              text: pasted,
              enter: false,
            },
            { timeoutMs: 30_000 },
          );
          delivered += 1;
        }
        await wsClient.call(
          "mobile.chat.send",
          {
            surface_id: surface.id || surface.ref,
            agent_kind: surface.agent?.agent_kind,
            text,
            enter: true,
          },
          { timeoutMs: 30_000 },
        );
      } catch (err) {
        setIsWorking(false);
        setActivityText(null);
        // Tell the composer which images are already sitting in the agent's input so a retry skips them.
        throw new PartialSendError(
          err instanceof Error ? err.message : "Could not send the message.",
          delivered,
        );
      }
      setTimeout(() => {
        void loadSessionTurns();
      }, 600);
      return;
    }

    // Show the message and the working state immediately: the gateway answers only after the agent has
    // taken the text and Enter was pressed, and a brand-new session has no transcript to echo it yet.
    const pending: PendingSend = {
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      text,
      baseline: countUserTurnsWithText(turns, text),
      createdAt: Date.now(),
    };
    setPendingSends((prev) => [...prev, pending]);
    setWithinGrace(true);
    setTimeout(() => setWithinGrace(false), PENDING_WORKING_GRACE_MS);
    setIsWorking(true);
    setActivityText("Thinking…");
    try {
      // No "\r" appended: the gateway pastes the text and presses Enter separately, per agent profile.
      // The gateway holds this call up to 8s for the agent to ingest the paste; allow for that.
      await wsClient.call(
        "mobile.chat.send",
        {
          surface_id: surface.id || surface.ref,
          agent_kind: surface.agent?.agent_kind,
          text,
          enter: true,
        },
        { timeoutMs: 30_000 },
      );
    } catch (err) {
      setPendingSends((prev) => prev.filter((p) => p.id !== pending.id));
      setIsWorking(false);
      setActivityText(null);
      throw err;
    }
    setTimeout(() => {
      void loadSessionTurns();
    }, 600);
  };

  const handleAnswerDialog = async (choice: number) => {
    if (!startupDialog) return;
    await wsClient.call(RPC_METHODS.CHAT_ANSWER_DIALOG, {
      surface_id: surface.id || surface.ref,
      fingerprint: startupDialog.fingerprint,
      choice,
    });
    // The dialog disappears on the next snapshot; refresh now instead of waiting for the poll.
    setStartupDialog(null);
    await loadSessionTurns();
  };

  const handleApprove = async () => {
    // The gateway picks the approval key per agent and requires an explicit kind; never guess one.
    const agentKind = surface.agent?.agent_kind;
    if (!agentKind) return;
    try {
      await wsClient.call("mobile.chat.approve", {
        surface_id: surface.id || surface.ref,
        agent_kind: agentKind,
      });
    } catch (err) {
      // A timeout or dropped socket must not vanish silently: the card would look unchanged.
      setForkStatus(`Approve failed: ${err instanceof Error ? err.message : "unknown error"}`);
      setTimeout(() => setForkStatus(null), 4000);
      return;
    }
    await loadSessionTurns();
  };

  const handleInterrupt = async () => {
    await wsClient.call("mobile.chat.interrupt", {
      surface_id: surface.id || surface.ref,
    });
  };

  const handleConfirmRename = async (nextTitle: string) => {
    if (!surfaceToRename || !onRenameSurface) return;
    const targetId = surfaceToRename.id || surfaceToRename.ref;
    await onRenameSurface(targetId, nextTitle);
    setSurfaceToRename(null);
  };

  const handleForceReload = () => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("reload", Date.now().toString());
      window.location.href = url.toString();
    } catch {
      window.location.reload();
    }
  };

  const handleConfirmClose = async () => {
    if (!surfaceToClose || !onCloseSurface) return;
    const targetId = surfaceToClose.id || surfaceToClose.ref;
    const isClosingCurrent = targetId === (surface.id || surface.ref);

    await onCloseSurface(targetId);
    setSurfaceToClose(null);

    if (isClosingCurrent && allSurfaces && onSelectSurface) {
      const remaining = allSurfaces.filter((item) => (item.id || item.ref) !== targetId);
      if (remaining.length > 0) {
        onSelectSurface(remaining[0]);
      } else {
        onBack();
      }
    }
  };

  return (
    <div className="flex flex-col h-full w-full max-w-4xl mx-auto overflow-hidden bg-[#0a0a0a] text-[#fafafa]">
      <header className="relative flex items-center justify-between gap-2 px-2 pt-[env(safe-area-inset-top,0px)] min-h-[calc(3.25rem+env(safe-area-inset-top,0px))] bg-[#141416] border-b border-white/[0.08] shrink-0 z-30 w-full">
        <div className="flex items-center gap-1 min-w-0 flex-1">
          <button
            type="button"
            onClick={onBack}
            className="w-10 h-10 rounded-xl hover:bg-[#242428] active:opacity-75 text-[#fafafa] flex items-center justify-center transition-colors shrink-0"
            title={`Back to ${workspace.title}`}
            aria-label={`Back to ${workspace.title}`}
          >
            <ChevronLeft className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={() => setShowSwitcher(true)}
            disabled={!allSurfaces || allSurfaces.length < 2 || !onSelectSurface}
            className="min-w-0 flex-1 pr-1 text-left rounded-lg active:opacity-75 disabled:active:opacity-100"
            aria-label={`Switch tab (current: ${surface.title})`}
          >
            <h1 className="text-[15px] font-semibold text-[#fafafa] truncate leading-tight flex items-center gap-1">
              <span className="truncate">{displaySurfaceTitle(surface.title)}</span>
              {allSurfaces && allSurfaces.length > 1 && (
                <>
                  <ChevronDown className="w-4 h-4 text-[#a3a3a3] shrink-0" aria-hidden="true" />
                  <span className="text-[11px] font-medium text-[#a3a3a3] shrink-0">
                    {allSurfaces.length}
                  </span>
                </>
              )}
            </h1>
            <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
              {connState !== "connected" && (
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    connState === "connecting" ? "bg-amber-400" : "bg-rose-500"
                  }`}
                />
              )}
              <p className="text-[12px] text-[#898989] truncate leading-none">{workspace.title}</p>
            </div>
          </button>
        </div>

        <div className="flex items-center gap-1.5 shrink-0 pr-1">
          {chatAvailable && (
            <div className="flex items-center p-1 bg-[#1e1e22] border border-white/[0.08] rounded-xl shrink-0">
              <button
                type="button"
                onClick={() => setViewMode("chat")}
                className={`flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[13px] font-medium transition-colors ${
                  activeMode === "chat"
                    ? "bg-[#3276f2] text-white shadow-sm"
                    : "text-[#a3a3a3] hover:text-[#fafafa]"
                }`}
              >
                <MessageSquare className="w-3.5 h-3.5" />
                <span>Chat</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode("terminal")}
                className={`flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[13px] font-medium transition-colors ${
                  activeMode === "terminal"
                    ? "bg-[#3276f2] text-white shadow-sm"
                    : "text-[#a3a3a3] hover:text-[#fafafa]"
                }`}
              >
                <Terminal className="w-3.5 h-3.5" />
                <span>Term</span>
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowMoreMenu((prev) => !prev)}
            className="w-9 h-9 rounded-xl bg-[#242428] hover:bg-[#2e2e34] active:opacity-75 text-[#fafafa] flex items-center justify-center transition-colors"
            title="Tab options"
            aria-label="Tab options"
          >
            <MoreHorizontal className="w-5 h-5" />
          </button>
        </div>

        {showMoreMenu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setShowMoreMenu(false)} />
            <div className="absolute right-3 top-[calc(100%+6px)] z-50 w-52 rounded-2xl bg-[#1c1c20] border border-white/[0.12] shadow-2xl py-1.5 overflow-hidden">
              {onCreateSurface && (
                <button
                  type="button"
                  onClick={() => {
                    setShowMoreMenu(false);
                    setShowNewModal(true);
                  }}
                  className="w-full min-h-[44px] px-4 flex items-center gap-3 text-[14px] font-medium text-[#fafafa] hover:bg-white/[0.06] active:bg-white/[0.1] transition-colors"
                >
                  <Plus className="w-4 h-4 text-[#a3a3a3]" />
                  <span>New Tab</span>
                </button>
              )}

              {onRenameSurface && (
                <button
                  type="button"
                  onClick={() => {
                    setShowMoreMenu(false);
                    setSurfaceToRename(surface);
                  }}
                  className="w-full min-h-[44px] px-4 flex items-center gap-3 text-[14px] font-medium text-[#fafafa] hover:bg-white/[0.06] active:bg-white/[0.1] transition-colors"
                >
                  <Pencil className="w-4 h-4 text-[#a3a3a3]" />
                  <span>Rename Tab</span>
                </button>
              )}

              {surface.agent?.session_id && FORKABLE_AGENTS.has(surface.agent.agent_kind) && (
                <button
                  type="button"
                  onClick={() => {
                    setShowMoreMenu(false);
                    void handleForkConversation();
                  }}
                  className="w-full min-h-[44px] px-4 flex items-center gap-3 text-[14px] font-medium text-[#fafafa] hover:bg-white/[0.06] active:bg-white/[0.1] transition-colors"
                >
                  <GitFork className="w-4 h-4 text-[#a3a3a3]" />
                  <span>Fork conversation</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  setShowMoreMenu(false);
                  handleForceReload();
                }}
                className="w-full min-h-[44px] px-4 flex items-center gap-3 text-[14px] font-medium text-[#fafafa] hover:bg-white/[0.06] active:bg-white/[0.1] transition-colors"
              >
                <RefreshCw className="w-4 h-4 text-[#a3a3a3]" />
                <span>Reload App</span>
              </button>

              {onCloseSurface && (
                <div className="border-t border-white/[0.08] mt-1 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setShowMoreMenu(false);
                      setSurfaceToClose(surface);
                    }}
                    className="w-full min-h-[44px] px-4 flex items-center gap-3 text-[14px] font-medium text-rose-400 hover:bg-rose-500/10 active:bg-rose-500/20 transition-colors"
                  >
                    <X className="w-4 h-4" />
                    <span>Close Tab</span>
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </header>

      {showSwitcher && allSurfaces && onSelectSurface && (
        <SurfaceSwitchSheet
          surfaces={allSurfaces}
          activeSurfaceId={surface.id || surface.ref}
          onSelect={onSelectSurface}
          onNew={() => setShowNewModal(true)}
          onClose={() => setShowSwitcher(false)}
        />
      )}

      <div className="flex-1 min-h-0 overflow-hidden min-w-0 max-w-full flex flex-col">
        {activeMode === "chat" ? (
          <OrcaChatView
            // Composer state (queued messages, draft) belongs to one surface; remount on switch.
            key={surface.id || surface.ref}
            turns={displayTurns}
            isLoading={initialLoading}
            agentKind={surface.agent?.agent_kind || "agent"}
            startupDialog={startupDialog}
            onAnswerDialog={handleAnswerDialog}
            onOpenTerminal={() => setViewMode("terminal")}
            hasMoreHistory={hasMoreHistory}
            isLoadingOlder={loadingOlder}
            onLoadOlder={handleLoadOlder}
            isWorking={isWorking || hasFreshPending}
            lifecycleState={lifecycleState}
            activityText={activityText}
            onSend={handleSendPrompt}
            onUploadImage={handleUploadImage}
            surfaceId={surface.id || surface.ref}
            onApprove={handleApprove}
            onInterrupt={handleInterrupt}
          />
        ) : (
          <RawTerminalView
            surfaceId={surface.id || surface.ref}
            surfaceTitle={surface.title}
            tty={surface.tty}
          />
        )}
      </div>

      {onCreateSurface && (
        <NewSurfaceModal
          isOpen={showNewModal}
          workspaceId={workspace.id}
          workspaceTitle={workspace.title}
          onClose={() => setShowNewModal(false)}
          onCreate={onCreateSurface}
        />
      )}

      {surfaceToRename && onRenameSurface && (
        <RenameSurfaceModal
          isOpen={Boolean(surfaceToRename)}
          currentTitle={surfaceToRename.title}
          onClose={() => setSurfaceToRename(null)}
          onRename={handleConfirmRename}
        />
      )}

      {surfaceToClose && (
        <CloseSurfaceDialog
          isOpen={Boolean(surfaceToClose)}
          surfaceTitle={surfaceToClose.title}
          onClose={() => setSurfaceToClose(null)}
          onConfirm={handleConfirmClose}
        />
      )}

      {forkStatus && (
        <div
          role="status"
          className="fixed left-1/2 -translate-x-1/2 bottom-[calc(5rem+env(safe-area-inset-bottom,0px))] z-50 max-w-[90vw] px-4 py-2 rounded-xl bg-[#1c1c20] border border-white/[0.12] text-[13px] text-[#fafafa] shadow-2xl"
        >
          {forkStatus}
        </div>
      )}
    </div>
  );
}
