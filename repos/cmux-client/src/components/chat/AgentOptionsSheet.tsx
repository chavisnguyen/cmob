import { useEffect, useState } from "react";
import { Loader2, SlidersHorizontal, X } from "lucide-react";
import { RPC_METHODS } from "../../protocol/rpc";
import { useComposerState } from "../../state/useComposerState";
import { wsClient } from "../../transport/wsClient";
import {
  effortAfterModelChange,
  resolveDisplayedEfforts,
  resolveSelectedModel,
  type AgentOptionsInfo,
} from "./agentOptions";

export function AgentOptionsSheet({
  surfaceId,
  agentKind,
  currentModel,
  disabledMidSession = false,
  onClose,
  onOpenTerminal,
}: {
  surfaceId: string;
  agentKind: string;
  currentModel?: string;
  disabledMidSession?: boolean;
  onClose: () => void;
  onOpenTerminal?: () => void;
}) {
  const [composerState, updateComposer] = useComposerState(surfaceId);
  const { chosenModel, chosenEffort } = composerState;

  const [info, setInfo] = useState<AgentOptionsInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    wsClient
      .call<AgentOptionsInfo>(RPC_METHODS.AGENT_OPTIONS, { agent_kind: agentKind })
      .then((r) => !cancelled && setInfo(r))
      .catch(
        (e) =>
          !cancelled && setLoadError(e instanceof Error ? e.message : "Could not load options."),
      );
    return () => {
      cancelled = true;
    };
  }, [agentKind]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const apply = async (option: "model" | "effort" | "fast", value?: string) => {
    if (disabledMidSession) return;
    setBusy(`${option}:${value ?? ""}`);
    setError(null);
    setNote(null);
    try {
      const r = await wsClient.call<{ status: string }>(
        RPC_METHODS.CHAT_SET_OPTION,
        { surface_id: surfaceId, agent_kind: agentKind, option, value },
        { timeoutMs: 30_000 },
      );
      if (r.status === "picker_opened") {
        onClose();
        onOpenTerminal?.();
        return;
      }
      if (option === "model" && value && info) {
        updateComposer((prev) => ({
          ...prev,
          chosenModel: value,
          chosenEffort: effortAfterModelChange(info, value, prev.chosenEffort),
        }));
      }
      if (option === "effort" && value) {
        updateComposer((prev) => ({ ...prev, chosenEffort: value }));
      }
      setNote("Sent to the agent.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the option.");
    } finally {
      setBusy(null);
    }
  };

  const selectedModel = resolveSelectedModel(info, chosenModel, currentModel);
  const activeEffort = chosenEffort ?? info?.default_effort ?? null;
  const efforts = info ? resolveDisplayedEfforts(info, selectedModel) : [];
  const fastModel = info?.models.find((m) => m.id === selectedModel && m.fast);
  const actionsDisabled = busy !== null || disabledMidSession;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center md:p-4 bg-black/65 backdrop-blur-[1px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Model and effort"
        className="w-full max-w-md max-h-[85dvh] flex flex-col rounded-t-xl md:rounded-xl bg-surface border-t md:border border-line-strong text-fg shadow-2xl overflow-hidden pb-[env(safe-area-inset-bottom,0px)] md:pb-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 h-11 bg-sidebar border-b border-line shrink-0">
          <h2 className="text-[13.5px] font-semibold flex items-center gap-2">
            <SlidersHorizontal className="w-3.5 h-3.5 text-muted" />
            <span>Model &amp; Effort</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 rounded-md hover:bg-raised text-muted hover:text-fg flex items-center justify-center"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3.5 overflow-y-auto scrollbar-sleek bg-bg">
          {!info && !loadError && <Loader2 className="w-4 h-4 animate-spin text-muted" />}
          {loadError && <p className="text-[12.5px] text-status-wait">{loadError}</p>}

          {disabledMidSession && info && (
            <p className="text-[12px] text-status-wait bg-status-wait/10 border border-status-wait/25 rounded-lg px-3 py-2">
              Wait for the current turn or prompt to finish before changing options.
            </p>
          )}

          {info?.mid_session === "picker" && (
            <div className="space-y-3">
              <p className="text-[12.5px] text-fg-soft leading-relaxed">
                {agentKind === "codex" ? "Codex" : "This agent"} selects its model and reasoning
                effort via an interactive picker in the Terminal tab.
              </p>
              <button
                type="button"
                disabled={actionsDisabled}
                onClick={() => void apply("model")}
                className="w-full h-9 rounded-lg bg-accent hover:bg-accent-strong disabled:opacity-50 text-[13px] font-medium text-bg transition-colors"
              >
                {busy ? "Opening…" : "Open Model Picker"}
              </button>
            </div>
          )}

          {info?.mid_session === "command" && (
            <>
              <section className="space-y-1.5">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-dim">
                  Model
                </h3>
                {info.models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    disabled={actionsDisabled}
                    onClick={() => void apply("model", m.id)}
                    className={`w-full text-left rounded-lg border px-3 py-2 disabled:opacity-50 transition-colors ${
                      selectedModel === m.id
                        ? "border-accent/55 bg-accent/10 text-fg"
                        : "border-line bg-sidebar hover:bg-surface text-fg-soft"
                    }`}
                  >
                    <div className="text-[13px] font-medium">{m.label}</div>
                    {m.description && (
                      <div className="text-[11.5px] text-muted">{m.description}</div>
                    )}
                  </button>
                ))}
              </section>

              {efforts.length > 0 && (
                <section className="space-y-1.5">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wider text-dim">
                    Effort
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    {efforts.map((e) => (
                      <button
                        key={e.value}
                        type="button"
                        disabled={actionsDisabled}
                        onClick={() => void apply("effort", e.value)}
                        className={`h-8 px-3 rounded-md text-[12px] font-medium disabled:opacity-50 transition-colors ${
                          activeEffort === e.value
                            ? "bg-accent text-bg"
                            : "bg-sidebar border border-line text-fg-soft hover:bg-raised"
                        }`}
                      >
                        {e.label}
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {fastModel && (
                <button
                  type="button"
                  disabled={actionsDisabled}
                  onClick={() => void apply("fast")}
                  className="w-full h-8 rounded-lg bg-raised hover:bg-line-strong disabled:opacity-50 text-[12.5px] font-medium text-fg"
                >
                  Toggle Fast Mode
                </button>
              )}

              <p className="text-[11.5px] leading-relaxed text-dim">
                Claude persists model and effort changes as defaults for future sessions on this
                Mac.
              </p>
            </>
          )}

          {error && <p className="text-[12px] text-status-err">{error}</p>}
          {note && !error && <p className="text-[12px] text-status-ok">{note}</p>}
        </div>
      </div>
    </div>
  );
}
